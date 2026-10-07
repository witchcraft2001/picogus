# SPDX-License-Identifier: GPL-2.0-or-later
import sys
sys.dont_write_bytecode = True
import importlib.util
import tempfile
import unittest
from pathlib import Path

path = Path(__file__).resolve().parents[3] / "tools/ultrags/budget_report.py"
spec = importlib.util.spec_from_file_location("budgets", path)
b = importlib.util.module_from_spec(spec)
spec.loader.exec_module(b)


class BudgetTests(unittest.TestCase):
    def test_variants_and_duplicate_headers(self):
        with tempfile.TemporaryDirectory() as tmp:
            names = {"iow": 10, "ior": 9, "m62429": 4, "audio_i2s": 8,
                     "spi_psram": 9, "spi_psram_fudge": 10, "qspi_psram": 11}
            header = "\n".join(f"static const struct pio_program {n}_program = {{ .length = {v}, }};" for n, v in names.items())
            Path(tmp, "one.pio.h").write_text(header)
            Path(tmp, "duplicate.pio.h").write_text(header)
            layouts = b.pio_programs(tmp)["layouts"]
            self.assertEqual([v["pio1_words"] for v in layouts], [17, 18, 21, 22])
            Path(tmp, "duplicate.pio.h").write_text(header.replace(".length = 8", ".length = 24"))
            with self.assertRaises(ValueError):
                b.pio_programs(tmp)

    def test_missing_pio_does_not_pass(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(ValueError):
                b.pio_programs(tmp)

    def test_stack_is_measured_once(self):
        sections = {".text": {"size": 1000, "address": b.SRAM_BASE},
                    ".bss": {"size": 200, "address": b.SRAM_BASE + 1000},
                    ".heap": {"size": 500, "address": b.SRAM_BASE + 1200},
                    ".stack_dummy": {"size": 2048, "address": b.SRAM_BASE + b.MAIN_BYTES + 4096},
                    ".stack1_dummy": {"size": 2048, "address": b.SRAM_BASE + b.MAIN_BYTES}}
        report = b.sram_budget(sections)
        self.assertEqual(report["used_main"], 1700)
        self.assertEqual(report["free_bytes"], 264 * 1024 - 1700 - 4096)
        del sections[".stack_dummy"]
        with self.assertRaises(ValueError):
            b.sram_budget(sections)

    def test_flash_requires_all_images_and_offsets(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "generated/multifw").mkdir(parents=True)
            (root / "generated/multifw/flash_firmware.h").write_text("#define FLASH_FIRMWARE1 32768")
            with self.assertRaises(ValueError):
                b.flash_layout(tmp)

    def test_exceeded_target_budget_is_negative(self):
        f = {"allocation_end": 2 * 1024 * 1024 - 4096, "settings_start": 2 * 1024 * 1024 - 4096}
        estimate = b.target_estimate({"used_main": 250 * 1024}, f, 50000)
        self.assertLess(estimate["sram"]["target_free_main"], 0)
        self.assertLess(estimate["flash"]["free_bytes"], 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
