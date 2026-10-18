# S7: кодревью и исправления, 2026-10-18

**План S7 выполнен не полностью. S7 остаётся IN_PROGRESS.** Изменения реализуют
native MOD4 subset; полный музыкальный профиль GS 1.05 из §15/S7 не реализован.
Этот отчёт описывает найденные дефекты и исправления, не заменяет полный gate.

## Существенные замечания

| Приоритет | Замечание | Результат ревью |
|---|---|---|
| P0 / открыто | Нет GS dispatcher всей таблицы §8, legacy LOAD/shrink/readback, GS FX/override/sign/mask, 6A/6B/reset/manual ticks, UGPLAY `/GS`, UGMON `/GS`, UGTEST GS/MOD4 | Эти требования не выполнены; GS musical bit остаётся выключенным. Удалена успешная заглушка LEGACY_INFO: до реального legacy-слоя возвращается BAD_OPCODE. |
| P1 / исправлено | Parser использовал 1084-byte header + локальный descriptor, SEAL добавлял ещё descriptor на 2-КиБ core1 stack | Header разбирается порциями до 240 bytes непосредственно в переданный descriptor; SEAL использует собственный SRAM workspace. |
| P1 / исправлено | Первая строка запускалась после первого интервала; F01 опаздывал, EE повторно применял tick0 и мог зациклить строку; E6 неверно считал повторы | Tick0 применяется на PLAY/SEEK, clock дробный, tempo staged на tick boundary; конечные EE/E6 и 65-pattern exact EOF проверены C-векторами. |
| P1 / исправлено | F00 замораживал только внутренний tracker, сохраняя foreground playing: ноты звучали и RESUME возвращал STATE | F00 синхронизирует PAUSE, глушит музыкальные lanes и сохраняет pins; независимые FX продолжают работать. |
| P1 / исправлено | SEEK оставлял старые lane/cache/trigger; RESUME включал пустые/завершённые голоса; 9xx менял исходные bounds/loop и пропускал intro | SEEK сбрасывает голоса/effects/default pan. RESUME активирует только существующие незавершённые lanes. Offset задаёт начальную phase оригинального source; loop bounds сохраняются. |
| P1 / исправлено | PCM instance оставался kind=0; MOD channel records были пустыми; voice_mask включал пустые голоса; проверялись ошибки только первых lanes | Возвращён PCM kind=1, MOD snapshot содержит note/volume/pan/period, маска отражает active lanes; PSRAM/read errors различаются с FORMAT и проверяются по всем занятым lanes. |
| P1 / исправлено | 5xy/6xy затирали память porta/vibrato, tremolo накапливал громкость, E1/E2 зависели от новой ноты, ED преждевременно менял instrument; отсутствовали 8xx, корректные waveform/glissando/offset memory | Исправлены выбранные эффекты и добавлены регрессионные векторы, включая ED>=speed/EC0, waveform retrigger control, finetune и porta saturation. Это ещё не полный независимый audio conformance report. |
| P1 / исправлено | BLOBTYPE принят за object kind: `/TYPE:BLOB` перестал считаться явно заданным; UGPLAY принимал BLOB и молча игнорировал MOD gain/pan/FX options | BLOBTYPE снова boolean marker; kind берётся из PCM_KIND. Восстановлена валидация READY kind, неподдерживаемые MOD options отклоняются до upload/PLAY. |
| P1 / исправлено | ID allocator не учитывал queued PLAY_MOD; SEEK до применения PLAY проверял старую song length | Учитываются все foreground PLAY events, проверка SEEK использует metadata принятого экземпляра; queued MOD descriptor не может быть перезаписан вторым MOD PLAY. |
| P1 / исправлено | Независимая модель использовала неверные snapshot offsets, не учитывала inactive order tail и сохраняла устаревший PASS при неудаче; не проверялись контекст/ISA budgets и собственные input hashes | Модель исправлена, добавлены общие production-C/model vectors и расширенная actual-EXE матрица. Verifier проверяет source/header/model/EXE/vector hashes и полноту contexts; семь negative freshness/tamper случаев отвергаются. |
| P1 / исправлено | S3–S5 host target не линковали новый ug_mod.c; ожидали прежний formats=7 | Source lists/metadata и additive CAPS expectations обновлены. HOST регрессии S2–S6 повторены. |
| P1 / исправлено | `s7-check` успешно завершался при заведомо незавершённом S7; Tester Notes указывали несуществующий PGMULTI.UF2 в CMake-каталоге | Native subset вынесен в s7-native-check/package, полный s7-check остаётся незакрытым. Для CMake MULTIFW указан реальный путь multifw-release/picogus.uf2. |

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

## Объём, необходимый для завершения S7

1. Полный GS слой, перечисленный в первой строке таблицы; все G01–G09 и отдельные
   обязательные PASS cases UGTEST GS из §15/S7.
2. Законченные native DSS команды SEEK, UGTEST MOD4 и GS monitor/CLI.
3. Адаптация/сверка с закреплённым Micromod: текущий tracker — собственная начальная
   реализация. Полные независимые note/tick traces всех нормативных effects,
   комбинаций и waveform modes, reproducible audio goldens, сравнение native/GS
   одного fixture ещё не выполнены. Тесты отдельных исправлений не закрывают T01/T04.
4. Полный S7 stage verifier/package и две свежие сборки с byte comparison
   EXE/UF2/ZIP/IMG, оба полных 8-МиБ ROUNDTRIP и нужные S0–S6 gates.
5. REAL: GS/PROPLAY на Sprinter, настоящая LOAD pause120s, I2S/LRCLK,
   render/bus budgets, zero underruns и звук. До этих измерений — REAL_PENDING.

Заявлять «весь S7 выполнен» либо GS 1.05 compatibility по имеющимся изменениям нельзя.
