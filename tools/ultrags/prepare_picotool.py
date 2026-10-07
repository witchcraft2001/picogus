#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""Install an exact picotool revision for file conversion, without SDK's develop fetch."""
import argparse
import hashlib
import json
import os
import subprocess
from pathlib import Path

REVISION = "ba3df406c37774144a059b2bdae73ab52587a1d2"
ORIGIN = "https://github.com/raspberrypi/picotool.git"


def run(args, cwd=None):
    subprocess.run(args, cwd=cwd, check=True)


def output(args, cwd=None):
    return subprocess.check_output(args, cwd=cwd, text=True).strip()


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True)
    parser.add_argument("--seed", help="optional existing clean checkout; exact revision still verified")
    args = parser.parse_args()
    root = Path(args.root).resolve()
    root.mkdir(parents=True, exist_ok=True)
    src, build, install = root / "source", root / "build", root / "install"
    sdk = Path(os.environ["PICO_SDK_PATH"]).resolve()
    if not src.exists():
        run(["git", "clone", args.seed or ORIGIN, str(src)])
    if subprocess.run(["git", "cat-file", "-e", REVISION + "^{commit}"], cwd=src,
                      stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode:
        run(["git", "fetch", ORIGIN, REVISION], src)
    # Recover an interrupted --no-checkout clone with no worktree/index yet.
    if not (src / ".git/index").exists():
        run(["git", "checkout", "--detach", REVISION], src)
    if output(["git", "status", "--porcelain", "--untracked-files=no"], src):
        raise ValueError("picotool source has local changes; refusing to overwrite")
    run(["git", "checkout", "--detach", REVISION], src)
    if output(["git", "rev-parse", "HEAD"], src) != REVISION:
        raise ValueError("picotool revision mismatch")
    executable = install / "picotool/picotool"
    stamp = root / "manifest.json"
    pin = {"revision": REVISION, "origin": ORIGIN,
           "sdk_revision": output(["git", "rev-parse", "HEAD"], sdk),
           "usb_support": False, "use": "UF2 generation and file inspection only"}
    previous = json.loads(stamp.read_text()) if stamp.exists() else {}
    if executable.is_file() and (install / "picotool/picotoolConfig.cmake").is_file():
        if all(previous.get(k) == v for k, v in pin.items()) and previous.get("sha256") == digest(executable):
            print("picotool pin PASS:", REVISION)
            return
    run(["cmake", "-S", str(src), "-B", str(build), "-DCMAKE_BUILD_TYPE=Release",
         "-DPICO_SDK_PATH=" + str(sdk), "-DPICOTOOL_NO_LIBUSB=1", "-DPICOTOOL_FLAT_INSTALL=1",
         "-DCMAKE_INSTALL_PREFIX=" + str(install)])
    run(["cmake", "--build", str(build), "--parallel"])
    run(["cmake", "--install", str(build)])
    run([str(executable), "version", "2.1.1"])
    pin.update(version=output([str(executable), "version"]), sha256=digest(executable))
    stamp.write_text(json.dumps(pin, indent=2) + "\n")


if __name__ == "__main__":
    main()
