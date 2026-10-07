#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
# Ultra GS provenance manifest generator (S0a).
# Records: git HEAD + dirty state, spec version/hash, toolchain and SDK
# versions/paths, submodule pins, build commands, artifact hashes.
# Output: generated JSON in ignored build/; source reports stay in tests/ultrags/reports/.

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import shlex
from pathlib import Path


def sh(args, cwd=None):
    try:
        result = subprocess.run(args, cwd=cwd, capture_output=True, text=True, check=True)
        return (result.stdout + result.stderr).strip()
    except OSError:
        return ""


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def tool_version(exe, args=("--version",)):
    out = sh([exe] + list(args))
    return out.splitlines()[0] if out else "not found"


def require_ignored_output(repo, path):
    """Do not overwrite source inputs or create generated files eligible for Git."""
    destination = Path(path).resolve()
    root = Path(repo).resolve()
    if destination.is_relative_to(root):
        result = subprocess.run(["git", "check-ignore", "--quiet", "--no-index",
                                 "--", str(destination.relative_to(root))], cwd=root)
        if result.returncode != 0:
            raise ValueError("generated manifest output must be ignored by Git: " + str(destination))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", required=True)
    ap.add_argument("--spec", required=True)
    ap.add_argument("--python", default=sys.executable,
                    help="python interpreter used by the builds")
    ap.add_argument("--artifacts", nargs="*", default=[],
                    help="files to hash into the manifest")
    ap.add_argument("--out", required=True)
    ap.add_argument("--build-dirs", nargs="*", default=[])
    ap.add_argument("--references", help="generated source hashes output in ignored build/ or reference/manifest.json")
    ap.add_argument("--spec-before-sha256")
    ap.add_argument("--picotool-manifest", required=True)
    ap.add_argument("--commands-file", required=True)
    a = ap.parse_args()

    repo = os.path.abspath(a.repo)
    require_ignored_output(repo, a.out)
    if a.references:
        require_ignored_output(repo, a.references)
    m = {"stage": "S0a", "schema": 1}
    m["build_commands"] = Path(a.commands_file).read_text().splitlines()

    # git state
    m["git"] = {
        "head": sh(["git", "rev-parse", "HEAD"], repo),
        "branch": sh(["git", "rev-parse", "--abbrev-ref", "HEAD"], repo),
        "dirty_files": sh(["git", "status", "--porcelain"], repo).splitlines(),
        "tracked_diff_sha256": hashlib.sha256(sh(["git", "diff", "HEAD", "--binary"], repo).encode()).hexdigest(),
    }

    # spec
    spec_txt = open(a.spec, "r", errors="replace").read()
    ver = re.search(r"(?:Версия ТЗ|version)[^\n]*?\*\*?(\d+\.\d+)", spec_txt[:3000], re.I)
    m["spec"] = {
        "path": os.path.relpath(a.spec, repo),
        "version": ver.group(1) if ver else "unknown",
        "sha256": sha256(a.spec),
        "before_review_status_sha256": a.spec_before_sha256,
    }

    # toolchain: record the python actually used by the builds (the
    # resampler table generator needs sympy/scipy/more-itertools there)
    sdk_path = os.environ.get("PICO_SDK_PATH", "")
    extras_path = os.environ.get("PICO_EXTRAS_PATH", "")
    m["toolchain"] = {
        "arm_gcc": tool_version("arm-none-eabi-gcc"),
        "cmake": tool_version("cmake"),
        "python3_build": a.python,
        "python3_build_version": tool_version(a.python),
        "sjasmplus": tool_version("sjasmplus"),
        "node": tool_version("node"),
        "pico_sdk_path": sdk_path,
        "pico_extras_path": extras_path,
        "pico_sdk_head": (sh(["git", "rev-parse", "HEAD"], sdk_path)
                         if sdk_path else "PICO_SDK_PATH not set"),
        "pico_extras_head": (sh(["git", "rev-parse", "HEAD"], extras_path)
                             if extras_path else "PICO_EXTRAS_PATH not set"),
    }
    m["toolchain"]["picotool"] = json.loads(Path(a.picotool_manifest).read_text())
    m["toolchain"]["sdk_dirty"] = sh(["git", "status", "--porcelain"], sdk_path).splitlines()
    m["toolchain"]["extras_dirty"] = sh(["git", "status", "--porcelain"], extras_path).splitlines()

    # submodule pins (gitlinks)
    subs = sh(["git", "ls-files", "-s"], repo)
    m["submodules"] = {}
    for line in subs.splitlines():
        mm = re.match(r"160000 ([0-9a-f]+)\s+\d+\s+(\S+)", line)
        if mm:
            m["submodules"][mm.group(2)] = mm.group(1)
    m["submodule_actual_status"] = sh(["git", "submodule", "status", "--recursive"], repo).splitlines()
    for entry in m["submodule_actual_status"]:
        if entry[:1] in ("-", "+", "U"):
            raise ValueError("missing or mismatched submodule: " + entry)

    # python deps resolved by the build interpreter
    deps = {}
    for pkg in ("sympy", "scipy", "more_itertools", "numpy", "mpmath"):
        deps[pkg] = sh([a.python, "-c",
                        f"import {pkg}; print({pkg}.__version__)"])
    m["python_deps"] = deps

    # artifacts keyed by repo-relative path: basenames collide across
    # build dirs (e.g. picogus.uf2 in release vs post-change dirs)
    m["artifacts"] = {}
    for f in a.artifacts:
        if not os.path.isfile(f):
            raise FileNotFoundError("requested artifact missing: " + f)
        m["artifacts"][os.path.relpath(f, repo)] = {
            "size": os.path.getsize(f), "sha256": sha256(f),
        }

    # Hash the actual compilation inputs, including modified local files.
    inputs = {Path(a.spec).resolve(), Path(repo, "Makefile.ultrags"),
              Path(repo, ".gitmodules"), Path(repo, ".gitignore"), Path(repo, "sw/CMakeLists.txt"),
              Path(repo, "tests/ultrags/reference/sources.json")}
    for directory in ("sw/ultrags", "tools/ultrags", "tests/ultrags/unit"):
        inputs.update(p.resolve() for p in Path(repo, directory).rglob("*")
                      if p.is_file() and "__pycache__" not in p.parts)
    for directory in a.build_dirs:
        for dep in Path(directory).rglob("*.o.d"):
            contents = dep.read_text().replace("\\\n", " ").split(":", 1)
            if len(contents) == 2:
                for name in shlex.split(contents[1]):
                    path = Path(name)
                    if path.is_file(): inputs.add(path.resolve())
    notices = {
        "rp2040-psram": Path(repo, "sw/rp2040-psram/LICENSE"),
        "tinyusb": Path(repo, "sw/tinyusb/LICENSE"),
        "tusb_xinput": Path(repo, "sw/tusb_xinput/LICENSE"),
        "pico-sdk": Path(sdk_path, "LICENSE.TXT"),
        "pico-extras": Path(extras_path, "LICENSE.TXT"),
        "Micromod reference only": Path(repo, "tests/ultrags/reference/micromod-licence.txt"),
        "M62429 reference license": Path(repo, "tests/ultrags/reference/M62429-LICENSE"),
        "picotool": Path(a.picotool_manifest).parent / "source/LICENSE.TXT",
    }
    inputs.update(p.resolve() for p in notices.values())
    for directory in ("sw/isa", "sw/M62429", "sw/rp2040-psram"):
        inputs.update(p.resolve() for p in Path(repo, directory).glob("*.pio"))
    inputs.add(Path(extras_path, "src/rp2_common/pico_audio_i2s/audio_i2s.pio").resolve())
    entries = []
    for path in sorted(inputs):
        text = path.read_text(errors="replace")[:10000]
        spdx = re.search(r"SPDX-License-Identifier:\s*([^\s*]+)", text)
        license_id = spdx[1] if spdx else "original header/component notice governs; not reclassified"
        origin = "PicoGUS fork/local working tree"
        revision = m["git"]["head"]
        for name, pin in m["submodules"].items():
            if path.is_relative_to(Path(repo, name)):
                origin, revision, license_id = name, pin, "MIT"
        if sdk_path and path.is_relative_to(Path(sdk_path)):
            origin, revision = "pico-sdk", m["toolchain"]["pico_sdk_head"]
            if not spdx: license_id = "BSD-3-Clause; component notice governs"
        if extras_path and path.is_relative_to(Path(extras_path)):
            origin, revision = "pico-extras", m["toolchain"]["pico_extras_head"]
            if not spdx: license_id = "BSD-3-Clause"
        if path.is_relative_to(Path(repo, "sw/M62429")) and not spdx:
            license_id = "MIT; upstream 0.3.6 notice cached"
        if path.is_relative_to((Path(a.picotool_manifest).parent / "source").resolve()):
            origin, revision, license_id = "picotool", m["toolchain"]["picotool"]["revision"], "BSD-3-Clause"
        if path.name.endswith(".pio.h"):
            if path.name == "audio_i2s.pio.h":
                origin, revision, license_id = "generated from pico-extras audio_i2s.pio", m["toolchain"]["pico_extras_head"], "BSD-3-Clause"
            elif path.name == "psram_spi.pio.h":
                origin, revision, license_id = "generated from rp2040-psram", m["submodules"]["sw/rp2040-psram"], "MIT"
            elif path.name == "M62429.pio.h":
                origin, license_id = "generated from existing PicoGUS M62429 adapter", "original PIO header governs; MIT library notice retained"
        entries.append({"path": os.path.relpath(path, repo), "sha256": sha256(path),
                        "origin": origin, "revision": revision, "license": license_id,
                        "use": "compiled input or local tooling/reference; retained original file"})
    reference = {"schema": 1, "stage": "S0a", "git_head": m["git"]["head"],
                 "spec": m["spec"], "sources": entries,
                 "notices": {name: {"path": os.path.relpath(p, repo), "sha256": sha256(p)}
                             for name, p in notices.items()},
                 "external_references": [
                     {"name": "Micromod", "revision": "83b5d9aebddb528ea177e115b0afed5d75f6b92a",
                      "license": "BSD-3-Clause", "use": "license audit only; no player code copied/compiled in S0a",
                      "url": "https://github.com/martincameron/micromod/blob/83b5d9aebddb528ea177e115b0afed5d75f6b92a/licence.txt"},
                     {"name": "M62429", "revision": "0.3.6 tag", "license": "MIT",
                      "url": "https://github.com/RobTillaart/M62429/blob/0.3.6/LICENSE",
                      "use": "license notice for pre-existing adapted fork sources"}]}
    if a.references:
        Path(a.references).parent.mkdir(parents=True, exist_ok=True)
        Path(a.references).write_text(json.dumps(reference, indent=2) + "\n")
        m["source_manifest"] = {"path": os.path.relpath(a.references, repo), "sha256": sha256(a.references)}
    else:
        m["source_inputs"] = entries

    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    open(a.out, "w").write(json.dumps(m, indent=2) + "\n")
    print(a.out)


if __name__ == "__main__":
    sys.exit(main())
