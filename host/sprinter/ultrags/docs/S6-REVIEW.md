# S6 code review — 2026-10-10

S6 выполнен частично. Итог ревью: **HOST_PARTIAL / DSS-EXE_PENDING / REAL_PENDING**.
Ревью охватывает staged изменения S6 и внесённые поверх них исправления. Commit,
push, прошивка платы и изменения соседних репозиториев не выполнялись.

## Обнаруженные ошибки и внесённые исправления

| Приоритет | Ошибка исходного изменения | Исправление и проверка |
|---|---|---|
| P1 | mainVol=100 давал 1/16 уровня; class gains и stereo balance теряли точность | Корректный Q15 taper, один multiplicative gain round, точные denominators balance. Проверены mute/unity/50%, малые gains, 1890 scalar cases |
| P1 | До mixer init в DMA копировались неинициализированные samples | Renderer всегда инициализирует output нулём; отсутствие I2S отключает audio CAPS |
| P1 | Paused FX lane считался свободным; old instance/pin мог потеряться | Allocation по instance masks, включая paused и принятые события; atomic stereo steal; NO_VOICE сохраняет состояние |
| P1 | Repeats перезапускались после quantum, добавляя тишину; floor step нарушал длительность; RAW loop пропускал intro | Whole-object repeats и wrap tap внутри phase advance; остаток Q32.32 шага сохраняется; intro проигрывается один раз. Exact scalar duration/sample checks |
| P1 | Управление применялось сразу, без ограниченной очереди | Очередь 16 событий на core1, validation по projected state, pin reservation до enqueue, применение перед quantum; BUSY без частичного изменения |
| P1 | SAVE/PORTS разрешались во время playing/paused PCM/FX | Отдельный atomic playback gate; transfer admission сохраняет возможность фонового I/O. Проверены SAVE и PORTS BUSY |
| P1 | RESET_STORE сохранял playback ссылки при повторном использовании handles | Reset сначала освобождает live/queued pins и lanes, затем очищает store |
| P1 | Cache tag оставался валидным после частично неудачного чтения; fault мог дать ненулевую интерполяцию | Tag invalidation до fill, fault silence, остановка целого instance и release pins; PSRAM error сохраняется в диагностике |
| P1 | Maintenance abort терял DMA ownership; два задержанных completion могли остановить chain | Полный ownership reset после abort; chronological completion и restart остановленного chain, SDK IRQ acknowledge. Mock recovery tests |
| P1 | Evidence сравнивал source hashes с ними же после исполнения; verifier принимал заменённые payload при новом manifest | Inputs фиксируются до build/run, обязательные executable/log/dependency sets; byte comparison с current artifacts и fresh fixtures; отрицательные проверки подмен |
| P2 | Стартовый mainVol читался core1 из изменяемого core0 Settings | Atomic publication на core0 при startup/processSettings и CMD_MAINVOL, чтение на quantum boundary |
| P2 | FX_STATUS count был ограничен четырьмя; missing CONTROL_FX ID давал STATE | Нормативный count1…7 с idle records незаявленных lanes, HANDLE для missing ID; FX_STATUS разрешён при transfer grant |
| P2 | EOF терял play ID/state; peaks/clipping/max_render не публиковались | EOF retention, 20 ms peak windows, saturating stats; CLEAR_STATS сохраняет position/error |
| P2 | WAV backing I/O failure возвращал FORMAT | Отличается PSRAM failure от malformed WAV; parser step <=24 bytes, отдельные reads <=16 |
| P2 | Render выполнялся после storage slice | Render обслуживается первым в core1 loop |

## Сверка с планом

| Часть плана | Состояние после ревью |
|---|---|
| RAW/WAV metadata, PCM_CONFIG, cooperative SEAL, original-file CRC/readback | Реализовано; HOST subset проверен, malformed parser matrix расширена |
| 48000 stereo S16, interpolation/gains/repeats/loops/cache | Реализовано; 1890 exact scalar cases, >4 MiB source address. Сохраняемые/exported audio goldens ещё отсутствуют |
| Foreground + independent four mono/two stereo FX, priorities/pins/IDs | Реализовано; allocator/control/reset/fault subset проверен. Полная приёмочная матрица A/F/P ещё не закрыта |
| DMA0/1, PIO1 SM3, три 128-frame SRAM buffers, continuous zero fallback | Production adapter и mock checks; физическая непрерывность/тайминги не измерены |
| Quantum-boundary queue16, mainVol, SAVE/PORTS BUSY, snapshots/stats | Исправлено и проверено в HOST subset; полная age/peaks/concurrent pipeline матрица и board volume measurements ещё нужны |
| UGLOAD RAW/WAV и PCM_CONFIG; UGPLAY; UGMON; UGTEST PCM/FX | **Не реализовано**. UGLOAD остаётся BLOB; UGPLAY/UGMON EXE отсутствуют, UGTEST PCM/FX не добавлены |
| WAIT/ESC, ownership handles, lost PLAY ACK reconciliation, DSS context/deadlines | **Не реализовано для S6**; проверки S3–S5 не заменяют эти сценарии |
| Independent DSS PCM/FX model и общие C/audio fixtures | **Не реализовано**. Обновлённые CAPS в старой модели не доказывают наличие audio поведения |
| Полный gate S6-main + свежий S6-review и EXE/UF2/ZIP/IMG byte compare | **Не выполнено**. В ревью выполнены перечисленные ниже проверки в S6-review; incremental package не является полной поставкой S6 |
| LRCLK, underruns, <=75% render quantum, bus budgets, звук | **REAL_PENDING**, требуют стенда |

## Выполненные проверки

В `build/S6-review` выполнены:

- `s6-host.py`: реальные parser/storage/render/DMA code под mocks и UBSan;
  четыре executable + logs + hashes в `host/s6/s6-host-evidence.json`.
- `run_host_tests.py`: S0a render/device/diagnostic variants, normal и UBSan,
  budget/UF2 negative checks. ASan SKIP: standalone empty runtime probe timeout.
- `s2-host.py`: Settings migration/config/context/concurrent INFO/GS.
- `s3-host.py`: 151771 C checks + 444 pinned PSRAM backend checks.
- `s4-host.py`: 28498848 C checks.
- `s5-host.py`: 44561459 C checks, full BULK VERIFIED pool roundtrips.
- Свежая assembly существующих 40 EXE; actual-EXE regressions S3: 106,
  S4: 112, S5: 515 сценариев, все PASS; общие C/model fixtures проверены.
- Incremental package verifier и negative tests: 10 согласованно rehashed
  подмен UF2/host binaries/evidence/log/fixture, удалённый UF2 и пустые HOST/firmware
  input maps отвергаются. Пакет содержит 98 current artifacts, не полный S6 bundle.
- Standalone release HANDSHAKE и экспериментальный POSTED builds, printf gate.
  HANDSHAKE SRAM reserve 162680 bytes (>16 KiB); Settings/protocol wire layouts
  и публичный ASM ABI не изменялись.

Полный firmware/multifw/diagnostic matrix, оба actual-EXE 8-МиБ ROUNDTRIP и две
свежие полные сборки в рамках этого ревью не выполнялись. Ранее полученная evidence
не переносится автоматически на изменённый C-код. Сборки и тесты после последних
исправлений повторяются для затронутых путей; подробные logs остаются в build.

## Следующая работа для завершения S6

Сначала реализовать DSS вертикальный сценарий RAW/WAV upload → SEAL → PLAY →
WAIT/control/monitor, включая FX и lost ACK. Затем закрыть независимые DSS/audio
fixtures, полную A01–A04/F02/F03/P11/concurrency матрицу, две свежие полные сборки и
полные packages. Физические измерения и слушательскую проверку выполнять отдельно;
§16 оставлен IN_PROGRESS, capabilities MOD/playlist не включены.
