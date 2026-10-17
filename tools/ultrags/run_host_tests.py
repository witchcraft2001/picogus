#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
# Fatal sanitizer results propagate; only a separate runtime probe can SKIP ASan.
import argparse
import os
import shlex
import shutil
import subprocess
from pathlib import Path


def run(args, timeout=45, env=None):
    print("+", shlex.join(map(str, args)), flush=True)
    subprocess.run(list(map(str, args)), check=True, timeout=timeout, env=env)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--build", required=True)
    parser.add_argument("--cc", default="cc")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    build = Path(args.build).resolve()
    build.mkdir(parents=True, exist_ok=True)
    sw = root / "sw/ultrags"
    tests = root / "tests/ultrags/unit"
    gen = build / "gen"
    run([os.sys.executable, root / "tools/ultrags/gen-diag.py", root / "tools/ultrags/diag-schema.json", gen])
    programs = {
        "render": [tests / "test_render.c", sw / "ug_render.c", sw / "ug_profile.c"],
        "s6-pcm": [tests / "test_s6_pcm.c", sw / "ug_pcm.c"],
        "device": [tests / "test_device.c", tests / "sdk_mock/sdk_mock.c",
                   sw / "ug_audio.c", sw / "ug_psram.c", sw / "ug_hwmap.c", sw / "ug_diag_link.c"],
    }

    programs["diag-isa"] = [tests / "test_diag_isa.c", sw / "ug_diag_isa.c", sw / "ug_diag_guard.c"]
    programs["diag-isa-no-dack"] = programs["diag-isa"]
    def suite(compiler, suffix, flags):
        for name, sources in programs.items():
            out = build / (name + suffix)
            run(compiler + ["-std=c11", "-O1", "-g", "-Wall", "-Wextra", "-pthread",
                            "-DPSRAM_ASYNC=1", "-DPSRAM_PIN_CS=1",
                            *(["-I" + str(tests / "s1_mock")] if name.startswith("diag-isa") else []), "-I" + str(tests / "sdk_mock"), "-I" + str(sw), "-I" + str(gen), "-I" + str(root / "common")] +
                (["-DUG_DIAG_NO_DACK=1"] if name.endswith("no-dack") else []) + flags +
                [str(p) for p in sources] + ["-o", str(out)])
            env = dict(os.environ, UBSAN_OPTIONS="halt_on_error=1:print_stacktrace=1",
                       ASAN_OPTIONS="halt_on_error=1")
            run([out], env=env)
            if name.startswith("diag-isa"):
                run([out, "slow-write-guard"], env=env)
                run([out, "read-guard", "during-assertion"], env=env)
                run([out, "slow-write-guard", "during-assertion"], env=env)

    suite(shlex.split(args.cc), "", [])
    clang = shutil.which("clang")
    if not clang:
        print("UBSan/ASan SKIP: clang unavailable", flush=True)
    else:
        suite([clang], "-ubsan", ["-fsanitize=undefined", "-fno-sanitize-recover=all", "-fno-omit-frame-pointer"])
        probe = build / "asan-probe.c"
        probe.write_text("int main(void) { return 0; }\n")
        exe = build / "asan-probe"
        try:
            run([clang, "-fsanitize=address", probe, "-o", exe])
            run([exe], timeout=5)
        except (subprocess.TimeoutExpired, subprocess.CalledProcessError) as error:
            print("ASan SKIP: standalone empty runtime probe failed:", type(error).__name__, flush=True)
        else:
            suite([clang], "-asan", ["-fsanitize=address", "-fno-omit-frame-pointer"])
    run([os.sys.executable, tests / "test_budgets.py"])
    run([os.sys.executable, tests / "test_s1_firmware.py"])
    print("S0a HOST TESTS PASS; REAL remains PENDING", flush=True)


if __name__ == "__main__":
    main()
