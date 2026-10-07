#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
# Validate the firmware baseline without installing or updating tools.
import argparse
import importlib.metadata
import json
import os
import re
import subprocess
from pathlib import Path


def output(args, cwd=None):
    result = subprocess.run(args, cwd=cwd, capture_output=True, text=True, check=True)
    return (result.stdout + result.stderr).strip()


def collect():
    tools = {name: output([name, "--version"]).splitlines()[0]
             for name in ("cmake", "arm-none-eabi-gcc", "arm-none-eabi-g++")}
    tools["python"] = output([os.sys.executable, "--version"])
    if tuple(map(int, re.search(r"\d+\.\d+\.\d+", tools["cmake"])[0].split("."))) < (3,29,0):
        raise ValueError("CMake >=3.29 required")
    if "14.2.Rel1" not in tools["arm-none-eabi-gcc"] or "14.2.Rel1" not in tools["arm-none-eabi-g++"]:
        raise ValueError("Arm GNU Toolchain 14.2.Rel1 required")
    if os.sys.version_info[:2] != (3,13):
        raise ValueError("UG_PYTHON must select Python 3.13.x")
    tools["packages"] = {name: importlib.metadata.version(name)
                         for name in ("sympy", "scipy", "more-itertools", "numpy", "mpmath")}
    for line in Path(__file__).with_name("requirements-build.txt").read_text().splitlines():
        if not line or line.startswith("#"): continue
        package, version = line.split("==")
        if tools["packages"][package] != version:
            raise ValueError("Python package pin mismatch: " + line)
    for variable, tag in (("PICO_SDK_PATH", "2.1.1"), ("PICO_EXTRAS_PATH", "sdk-2.1.1")):
        path = os.environ.get(variable)
        if not path:
            raise ValueError(variable + " must be set")
        head = output(["git", "rev-parse", "HEAD"], path)
        pinned = output(["git", "rev-parse", tag + "^{commit}"], path)
        if head != pinned:
            raise ValueError(variable + " does not match " + tag)
        tools[variable] = {"path": path, "tag": tag, "head": head,
                           "dirty": output(["git", "status", "--porcelain"], path).splitlines()}
        if tools[variable]["dirty"]:
            raise ValueError(variable + " has local changes; pinned baseline cannot be verified")
    root = Path(__file__).resolve().parents[2]
    status = output(["git", "submodule", "status", "--recursive"], root)
    if any(line[:1] in ("-", "+", "U") for line in status.splitlines()):
        raise ValueError("initialize pinned submodules; revision drift is forbidden")
    tools["submodule_status"] = status.splitlines()
    return tools


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--out")
    args = parser.parse_args()
    try:
        result = collect()
    except (OSError, ValueError, subprocess.CalledProcessError, importlib.metadata.PackageNotFoundError) as error:
        parser.exit(2, "preflight FAIL: " + str(error) + "\n")
    if args.out:
        Path(args.out).write_text(json.dumps(result, indent=2) + "\n")
    print("preflight PASS: SDK2.1.1/extras, GCC14.2.Rel1, CMake>=3.29, Python3.13, pinned submodules")
