Ultra GS: what belongs in Git

Keep firmware and host-test sources, build scripts, dependency pins, third-party
license notices, manually written stage reports and reproduction instructions.
The files in tests/ultrags/unit/sdk_mock/, including *.pio.h, are handwritten
test substitutes; they are source inputs, not generated PIO headers.

Store build outputs in ignored build/ (or publish them as CI/release artifacts):
ELF/BIN/UF2, linker maps and compressed maps, logs, generated PIO headers,
dependency lists, compiler intermediates, budget/host-environment JSON,
artifact checksums, regression dumps and complete generated provenance manifests.
Saving maps for stage acceptance means retaining build artifacts locally or in
an artifact archive; it does not require adding them to the source repository.

tests/ultrags/reference/sources.json is the maintained source/licensing inventory.
tests/ultrags/reference/manifest.json, if generated, is ignored. Generate complete
hash inventories with tools/ultrags/manifest.py; its output must be ignored by Git.

S0a reproduction commands: S0a-review-2026-10-07/commands.txt.
Builds and local evidence: build/S0a-review/.
Historical executor output: build/S0a-review/evidence/history/S0a-2026-10-07/.
Historical review output: build/S0a-review/evidence/review/.
The historical snapshots describe their original paths at the time of review.
Fresh generated manifests and source hashes: build/S0a-review/evidence/current/.
These build paths are local output locations, not prerequisites for a fresh clone.
