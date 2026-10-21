Актуализация 2026-10-21: этот документ описывает исторический native subset.
Текущие GS dispatcher/LOAD/FX и GS CLI проверяются отдельным `gs105-check`;
инструкции и границы доказательств — [GS105-README.md](GS105-README.md).
Прежние формулировки «GS dispatcher отсутствует» относились к дате исходного ревью.
S7 остаётся IN_PROGRESS / REAL_PENDING до аппаратной приёмки.

# S7: кодревью и исправления, 2026-10-18

**План S7 выполнен не полностью. S7 остаётся IN_PROGRESS.** Изменения реализуют
native MOD4 subset на дату 2026-10-18. По состоянию на 2026-10-21 музыкальный
профиль GS 1.05 и CLI имеют HOST_PASS / DSS_EXE_PASS; аппаратная приёмка открыта.
Этот отчёт сохраняет историю исправлений; текущие доказательства — GS105-CONFORMANCE.

## Существенные замечания

| Приоритет | Замечание | Результат ревью |
|---|---|---|
| P0 / программно закрыто 2026-10-21 | GS dispatcher §8, LOAD/shrink/readback, FX/sign/masks, 6A/6B/reset/manual ticks и GS CLI отсутствовали | Реализованы; GS musical bit включён. G01–G09, T01/T04 и F01/F04/P11 имеют исполняемые проверки в GS105-CONFORMANCE. Аппаратная приёмка REAL_PENDING. |
| P1 / исправлено | Parser использовал 1084-byte header + локальный descriptor, SEAL добавлял ещё descriptor на 2-КиБ core1 stack | Header разбирается порциями до 240 bytes непосредственно в переданный descriptor; SEAL использует собственный SRAM workspace. |
| P1 / исправлено | Первая строка запускалась после первого интервала; F01 опаздывал, EE повторно применял tick0 и мог зациклить строку; E6 неверно считал повторы | Tick0 применяется на PLAY/SEEK, clock дробный, tempo staged на tick boundary; конечные EE/E6 и 65-pattern exact EOF проверены C-векторами. |
| P1 / исправлено | F00 замораживал только внутренний tracker, сохраняя foreground playing: ноты звучали и RESUME возвращал STATE | F00 синхронизирует PAUSE, глушит музыкальные lanes и сохраняет pins; независимые FX продолжают работать. |
| P1 / исправлено | SEEK оставлял старые lane/cache/trigger; RESUME включал пустые/завершённые голоса; 9xx менял исходные bounds/loop и пропускал intro | SEEK сбрасывает голоса/effects/default pan. RESUME активирует только существующие незавершённые lanes. Offset задаёт начальную phase оригинального source; loop bounds сохраняются. |
| P1 / исправлено | PCM instance оставался kind=0; MOD channel records были пустыми; voice_mask включал пустые голоса; проверялись ошибки только первых lanes | Возвращён PCM kind=1, MOD snapshot содержит note/volume/pan/period, маска отражает active lanes; PSRAM/read errors различаются с FORMAT и проверяются по всем занятым lanes. |
| P1 / исправлено | 5xy/6xy затирали память porta/vibrato, tremolo накапливал громкость, E1/E2 зависели от новой ноты, ED преждевременно менял instrument; отсутствовали 8xx, корректные waveform/glissando/offset memory | Исправлены выбранные эффекты и добавлены регрессионные векторы, включая ED>=speed/EC0, waveform retrigger control, finetune и porta saturation. В GS105 gate добавлены независимые tick traces, Micromod intersection и FX audio oracle. |
| P1 / исправлено | BLOBTYPE принят за object kind: `/TYPE:BLOB` перестал считаться явно заданным; UGPLAY принимал BLOB и молча игнорировал MOD gain/pan/FX options | BLOBTYPE снова boolean marker; kind берётся из PCM_KIND. Восстановлена валидация READY kind, неподдерживаемые MOD options отклоняются до upload/PLAY. |
| P1 / исправлено | ID allocator не учитывал queued PLAY_MOD; SEEK до применения PLAY проверял старую song length | Учитываются все foreground PLAY events, проверка SEEK использует metadata принятого экземпляра; queued MOD descriptor не может быть перезаписан вторым MOD PLAY. |
| P1 / исправлено | Независимая модель использовала неверные snapshot offsets, не учитывала inactive order tail и сохраняла устаревший PASS при неудаче; не проверялись контекст/ISA budgets и собственные input hashes | Модель исправлена, добавлены общие production-C/model vectors и расширенная actual-EXE матрица. Verifier проверяет source/header/model/EXE/vector hashes и полноту contexts; семь negative freshness/tamper случаев отвергаются. |
| P1 / исправлено | S3–S5 host target не линковали новый ug_mod.c; ожидали прежний formats=7 | Source lists/metadata и additive CAPS expectations обновлены. HOST регрессии S2–S6 повторены. |
| P1 / исправлено | `s7-check` успешно завершался при заведомо незавершённом S7; Tester Notes указывали несуществующий PGMULTI.UF2 в CMake-каталоге | Native subset вынесен в s7-native-check/package; s7-check теперь требует отдельный gs105-check. Для CMake MULTIFW указан реальный путь multifw-release/picogus.uf2. |

## Проверки и пределы доказательств

`tools/ultrags/s7-host.py` собирает production parser/ticker и storage под UBSan.
`tests/ultrags/dss/run-s7.mjs` исполняет именно собранные Z80 EXE и сравнивает
общие векторы с независимой structural/timing моделью. Матрица native пути
включает оба slots, EI/DI, исходный Turbo on/off, hardware inhibit, PAGE3,
FORMAT/disk/capability ошибки, lost PLAY reply, targeted WAIT/ESC, F00/resume,
загрузку 65 patterns >64 КиБ и BLOB regression. Снимки сравниваются по wire offsets;
в общих векторах исключены только nondeterministic sequence и audio peaks,
для которых структурная модель не имеет mixer.

Результаты/счётчики/hashes сохраняются в ignored `build/S7-review/`, прежде
всего REPORT-S7-NATIVE.txt, s7-dss-evidence.json, host/s7/s7-host-evidence.json.
Артефакты появляются только после исполнения проверок. Отдельные ZIP/IMG
создаются как **native review subset** и проверяются независимым extractor.
Standalone ULTRAGS и семирежимный MULTIFW собираются с pinned toolchain и link-time
provenance; NE2K — сборочная регрессия. Они не являются принятым S7 release.

## Текущий оставшийся объём S7

Программные GS/CLI, независимые effects/FX проверки и сравнение двух сборок
перенесены в GS105 gate. Актуальная матрица и ограничения находятся в
`build/GS105-CONFORMANCE.{md,json}`, хеши поставки — `build/DELIVERY.json`.
Их нельзя заменять историческими результатами из S7-review.

Открыта аппаратная приёмка: GS/PROPLAY на Sprinter с Turbo OFF, настоящая
LOAD pause120s, I2S/LRCLK, render/bus budgets, отсутствие underruns,
прослушивание и длительные прогоны. До этих измерений S7 IN_PROGRESS / REAL_PENDING.
Известный отказ GS при Turbo ON относится к следующему этапу, за ним — FLT8.
