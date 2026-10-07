#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
# Ultra GS S0a: measured ELF/Flash/PIO budgets and explicitly labelled MVP estimates.
import argparse
import json
import re
import subprocess
from pathlib import Path

SRAM_BASE = 0x20000000
MAIN_BYTES = 256 * 1024
SCRATCH_BYTES = 4096
FLASH_BYTES = 2 * 1024 * 1024
SETTINGS_BYTES = 4096
IMAGES = ("pg-gus", "pg-adlib", "pg-mpu", "pg-psg", "pg-sb", "pg-usb")


def run(cmd):
    return subprocess.run(cmd, check=True, capture_output=True, text=True).stdout


def sections(prefix, elf):
    result = {}
    for line in run([prefix + "-size", "-A", str(elf)]).splitlines():
        match = re.match(r"^(\.\S+)\s+(\d+)\s+(\d+)$", line.strip())
        if match:
            result[match[1]] = {"size": int(match[2]), "address": int(match[3])}
    if ".text" not in result or ".bss" not in result:
        raise ValueError("missing ELF SRAM sections: " + str(elf))
    return result


def sram_budget(secs, cores=2):
    required = (".stack_dummy", ".heap") + ((".stack1_dummy",) if cores == 2 else ())
    if any(k not in secs for k in required):
        raise ValueError("missing measured stack/heap sections; refusing guessed sizes")
    main = sum(v["size"] for v in secs.values()
               if SRAM_BASE <= v["address"] < SRAM_BASE + MAIN_BYTES)
    sx = secs.get(".scratch_x", {"size": 0})["size"]
    sy = secs.get(".scratch_y", {"size": 0})["size"]
    stack0 = secs[".stack_dummy"]["size"]
    stack1 = secs.get(".stack1_dummy", {"size": 0})["size"]
    return {"sections": secs, "used_main": main, "core0_stack": stack0,
            "core1_stack": stack1, "scratch_x_used": sx + stack1,
            "scratch_y_used": sy + stack0, "free_main": MAIN_BYTES - main,
            "free_bytes": MAIN_BYTES + 2 * SCRATCH_BYTES - main - sx - sy - stack0 - stack1,
            "note": "Actual section addresses; dummy stacks reserved in scratch banks, no double count."}


def pio_programs(build):
    programs = {}
    for path in sorted(Path(build).rglob("*.pio.h")):
        for name, length in re.findall(r"static const struct pio_program (\w+)_program = \{[^}]*\.length = (\d+)", path.read_text(), re.S):
            length = int(length)
            if name in programs and programs[name]["length"] != length:
                raise ValueError("ambiguous generated PIO program: " + name)
            programs[name] = {"length": length, "header": str(path)}
    required = ("iow", "ior", "audio_i2s", "m62429", "spi_psram", "spi_psram_fudge")
    if any(name not in programs for name in required):
        raise ValueError("missing required generated PIO header/program")
    layouts = []
    for m62429 in (False, True):
        for fudge in (False, True):
            p0 = ["iow", "ior"]
            p1 = ["audio_i2s", "spi_psram_fudge" if fudge else "spi_psram"]
            if m62429:
                p1.append("m62429")
            layouts.append({"m62429": m62429, "fudge": fudge,
                            "pio0_programs": p0, "pio1_programs": p1,
                            "pio0_words": sum(programs[n]["length"] for n in p0),
                            "pio1_words": sum(programs[n]["length"] for n in p1)})
    return {"programs": programs, "layouts": layouts,
            "note": "Mutually exclusive SPI variants; unused QSPI excluded. Runtime offsets/claims remain REAL_PENDING."}


def settings_abi(sw, tools, prefix, work):
    obj = Path(work) / "settings_abi.o"
    run([prefix + "-gcc", "-mcpu=cortex-m0plus", "-mthumb", "-std=c11", "-O2",
         "-I", str(sw), "-c", str(Path(tools) / "settings_abi.c"), "-o", str(obj)])
    result = {}
    for line in run([prefix + "-nm", "-S", str(obj)]).splitlines():
        match = re.search(r"([0-9a-f]+)\s+[Bb]\s+ug_abi_(\w+)$", line)
        if match:
            result[match[2]] = int(match[1], 16) - int(match[2].startswith("off_"))
    if any(key not in result for key in ("sizeof_settings", "sizeof_ugtail", "settings_version")):
        raise ValueError("incomplete ARM Settings ABI measurement")
    return result


def flash_layout(multifw):
    root = Path(multifw)
    header = (root / "generated/multifw/flash_firmware.h").read_text()
    offsets = {int(n): int(off) for n, off in re.findall(r"#define FLASH_FIRMWARE(\d+) (\d+)", header)}
    if set(offsets) != set(range(1, 7)):
        raise ValueError("baseline must have six generated image offsets")
    boot = (root / "bootloader.bin").stat().st_size
    if boot > offsets[1] or offsets[1] != 32768:
        raise ValueError("invalid baseline bootloader reserve")
    images = []
    for i, name in enumerate(IMAGES, 1):
        size = (root / (name + "-multifw.bin")).stat().st_size
        off = offsets[i]
        if off % 1024 or (images and off < images[-1]["end"]):
            raise ValueError("overlapping or unaligned baseline images")
        images.append({"name": name, "mode_id": i, "offset": off,
                       "length": size, "end": off + size})
    end = images[-1]["end"]
    # Historical generator allocates (size//1024 + 1)*1024, even for exact multiples.
    allocation_end = images[-1]["offset"] + (images[-1]["length"] // 1024 + 1) * 1024
    return {"bootloader_bytes": boot, "bootloader_reserved": offsets[1], "images": images,
            "image_end": end, "allocation_end": allocation_end,
            "settings_start": FLASH_BYTES - SETTINGS_BYTES,
            "free_for_future_images": FLASH_BYTES - SETTINGS_BYTES - allocation_end,
            "prefix": "length includes the existing 256-byte image prefix"}


def target_estimate(diag, flash, diag_bytes):
    rows = [
        ("future code beyond measured spike", 65536, "estimate: protocol/GS/tracker/player code"),
        ("128 object metadata entries", 128 * 96, "estimate, includes handles/state/pins"),
        ("257 allocator extents", 257 * 16, "estimate: worst-case split/free extents"),
        ("32 playlist entries", 32 * 16, "estimate, separate from object pins"),
        ("64 audio events", 64 * 24, "estimate, separate event queue"),
        ("front-end/request/response queues", 4096, "estimate, excludes transfer staging"),
        ("two transfer staging buffers", 2 * 1024, "spec §9.3"),
        ("MOD pattern cache and player state", 8192, "estimate"),
        ("parser/CRC scratch", 4096, "estimate"),
        ("12 lanes/cache and three DMA buffers", 0, "already in diagnostic bss; never count twice"),
    ]
    added = sum(size for _, size, _ in rows)
    target_main = diag["used_main"] + added
    # Four KiB per core fits each scratch bank; it is a reservation, not a stack-usage measurement.
    ultra_reserve = ((diag_bytes + 192 * 1024 + 1023) // 1024) * 1024
    catalog_reserve = 1024
    future_end = flash["allocation_end"] + catalog_reserve + ultra_reserve
    return {"sram": {"baseline_main": diag["used_main"],
                     "additional": [{"purpose": n, "bytes": b, "basis": basis} for n, b, basis in rows],
                     "target_main": target_main, "target_free_main": MAIN_BYTES - target_main,
                     "target_stack_each": 4096,
                     "status": "ESTIMATE, not linked full-MVP SRAM proof"},
            "flash": {"legacy_allocation_end": flash["allocation_end"],
                      "catalog_bytes": 148, "catalog_reserved": catalog_reserve,
                      "ultrags_image_reserved": ultra_reserve,
                      "ultrags_basis": "measured diagnostic + 192 KiB explicit future code/tables/slack estimate",
                      "seven_image_end": future_end, "settings_start": flash["settings_start"],
                      "free_bytes": flash["settings_start"] - future_end,
                      "present_ids": [1,2,3,4,5,6,8], "absent_id": 7,
                      "status": "ESTIMATE; S2 must link/pack seven images and validate CRC/bounds"}}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--build-dir", required=True)
    parser.add_argument("--multifw-dir", required=True)
    parser.add_argument("--ne2k-dir", required=True)
    parser.add_argument("--sw", default="sw")
    parser.add_argument("--tools", default="tools/ultrags")
    parser.add_argument("--armgcc", default="arm-none-eabi")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    build = Path(args.build_dir)
    diag = sram_budget(sections(args.armgcc, build / "pg-ultrags-diag.elf"))
    baseline = {name: sram_budget(sections(args.armgcc, Path(args.multifw_dir) / (name + "-multifw.elf"))) for name in IMAGES}
    baseline["bootloader"] = sram_budget(sections(args.armgcc, Path(args.multifw_dir) / "bootloader.elf"), cores=1)
    baseline["pg-ne2k"] = sram_budget(sections(args.armgcc, Path(args.ne2k_dir) / "pg-ne2k.elf"))
    flash = flash_layout(args.multifw_dir)
    pio = pio_programs(build)
    abi = settings_abi(args.sw, args.tools, args.armgcc, build)
    estimate = target_estimate(diag, flash, (build / "pg-ultrags-diag.bin").stat().st_size)
    checks = [
        ("settings_page", abi["sizeof_settings"] < 256 and abi["sizeof_ugtail"] < 256),
        ("diagnostic_main_free_16k", diag["free_main"] >= 16384),
        ("diagnostic_scratch_fit", diag["scratch_x_used"] <= 4096 and diag["scratch_y_used"] <= 4096),
        ("pio_all_variants_fit", all(v["pio0_words"] <= 32 and v["pio1_words"] <= 32 for v in pio["layouts"])),
        ("baseline_flash_fit", flash["allocation_end"] <= flash["settings_start"]),
        ("baseline_sram_fit", all(v["free_main"] >= 0 and v["scratch_x_used"] <= 4096 and v["scratch_y_used"] <= 4096 for v in baseline.values())),
        ("target_sram_estimate_free_16k", estimate["sram"]["target_free_main"] >= 16384),
        ("seven_image_flash_estimate_fit", estimate["flash"]["free_bytes"] >= 0),
    ]
    resources = {"ISA": {"PIO": 0, "SM": [0,1], "core": 0, "IRQ": "polling"},
                 "M62429": {"PIO": 1, "SM": 0, "conditional": "PicoGUS2 only"},
                 "PSRAM": {"PIO": 1, "SM": 1, "DMA": [2,3,4], "core": 1, "IRQ": "polling completion"},
                 "I2S": {"PIO": 1, "SM": 3, "DMA": [0,1], "core": 1, "IRQ": "DMA_IRQ_0", "priority": 64},
                 "CRC": {"DMA": 5, "state": "reserved, no CRC engine in S0a"},
                 "reserve": {"PIO0_SM": [2,3], "PIO1_SM": [2], "DMA": list(range(6,12))}}
    report = {"measured": {"diagnostic_sram": diag, "baseline_sram": baseline,
                           "flash": flash, "pio": pio, "settings_abi": abi},
              "resource_plan": resources, "estimates": estimate,
              "checks": [{"id": name, "pass": bool(ok)} for name, ok in checks]}
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(report, indent=2) + "\n")
    for name, ok in checks:
        print(("PASS " if ok else "FAIL ") + name)
    print("SRAM diagnostic/main-free:", diag["used_main"], diag["free_main"])
    print("SRAM target estimate/free:", estimate["sram"]["target_main"], estimate["sram"]["target_free_main"])
    print("PIO variants:", [(v["m62429"],v["fudge"],v["pio0_words"],v["pio1_words"]) for v in pio["layouts"]])
    print("Seven-image Flash estimate free:", estimate["flash"]["free_bytes"])
    return int(not all(ok for _, ok in checks))

if __name__ == "__main__":
    raise SystemExit(main())
