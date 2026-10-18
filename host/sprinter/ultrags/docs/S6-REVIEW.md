# S6 review history and completion — 2026-10-18

Текущий программный gate: **HOST_PASS / DSS-EXE_PASS / REAL_PENDING**; S6 остаётся IN_PROGRESS.
Ниже сохранено исходное ревью 2026-10-10: его outstanding-пункты закрывает дополнение в конце файла.
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

## Завершение программного S6 — 2026-10-18

Добавлены общий RAW/WAV loader, PCM_CONFIG, UGPLAY file/HANDLE/foreground/FX,
UGMON и UGTEST PCM/FX. READY PCM assets сохраняются до явного FREE; WAIT/ESC
управляет собственным playback token. Неверный новый объект не останавливает
foreground; замена playing/paused требует REPLACE. Lost ALLOC/PLAY не повторяются:
transport reset, session/state reconciliation, подтверждение нового token либо
TIMEOUT с неопределённым результатом. Утилиты будущих этапов отклоняются до bus I/O.

Независимая DSS PCM/FX-модель сверяется с реальными C-векторами. Она моделирует
время, quantum events, EOF, pins, stereo allocator/steal и циклические tokens;
actual EXE проходят контекстную, файловую и recovery-матрицы. Индексированные
S16LE goldens включают 1890 scalar cases и clipping с проверяемым frame accounting.
Добавлена проверка больших source phases через 1/2/4 МиБ и точного EOF 8 МиБ.
Фоновая verified загрузка и readback играющего PCM проверяются C и actual EXE.

S6 gate теперь требует полный S0–S5 software gate, обе полные 8-МиБ actual-EXE
ROUNDTRIP, свежие PCM/FX HOST/DSS evidence, firmware provenance и полную поставку
EXE/UF2/ZIP/IMG. Verifier отвергает устаревшие входы, заменённые файлы и пропущенные
proof artifacts даже при пересчитанном manifest. Две свежие сборки и byte compare:
`build/S6-complete-a`, `build/S6-complete-b`, `REPORT-S6-COMPARISON.txt`.
Команды воспроизведения и Tester Notes — S6-README.md.

Прежние staged ISA/Turbo исправления сохранены: SYS_PORT.RAM=2/3, PAGE3/IFF,
<=8 payload bytes и отдельные ISA/DI budgets. Protocol/API/Settings не изменены.
LRCLK, физическая непрерывность I2S, render/bus budgets и слушательская проверка
остаются REAL_PENDING. MOD/legacy GS/playlist и MOD8+FX performance — следующие
этапы; они не объявляются реализованными этим gate. Commit/push/прошивка платы
не выполнялись.

Заключительный CLI-аудит: общий parser модуля UGTEST теперь отклоняет команды
UGMEM до DISCOVER/UG_OPEN; `UGTEST FREE 1` проверяется actual EXE на syntax code=1
без аппаратных записей. Эта поправка не разрешает недокументированные suites.

## Повторное ревью — 2026-10-18

- P1: потерянный SEAL ACK оставлял OWN=1 даже у READY PCM, и error cleanup удалял
  загруженный семпл. Добавлены transport reset и проверка session/OBJECT_INFO,
  сохранение READY с напечатанным handle и TIMEOUT; SEAL/PLAY не повторяются.
  Cleanup дополнительно проверяет READY перед FREE. Actual EXE проверяет RAW,
  WAV и смену session с повторно использованным номером handle.
- P2: FX `/WAIT` принимал исчезновение instance после PSRAM fault за EOF и
  возвращал PASS. Добавлена сверка счётчика PSRAM errors до PLAY и после
  исчезновения token; новый сбой возвращает audio error. Отдельные сценарии
  проверяют старую sticky ошибку и повторный сбой с тем же audio_error.
- P2: параметры VOICE/PRIORITY/GAIN/PAN у команд управления молча игнорировались.
  Parser теперь учитывает явно переданные параметры, включая значения по
  умолчанию; неподходящие ключи отклоняются без аппаратных обращений.
- P1: UGTEST PCM/FX при lost PLAY ACK оставлял неизвестный playback token
  и pinned тестовый asset. Cleanup после применения очереди сверяет session,
  находит instances по собственному handle, останавливает их и освобождает
  временный объект; чужой foreground сохраняется. Оба suites проверены actual EXE.
  Проверка PCM/FX capabilities перенесена до ALLOC временного объекта suite.
- Уточнение плана: обычный выход UGPLAY после ACK оставляет звук и playback pins
  активными, как прямо требует §1.1 ТЗ. Pins снимаются при EOF/STOP/ESC, а READY
  asset сохраняется во всех случаях до FREE. Формулировка README о снятии pins
  при любом выходе программы исправлена; FREE играющего объекта остаётся PINNED.
- P2: BLOB_SETUP мог молча принять новую session после напечатанной старой session.
  Все приложения теперь фиксируют session при первом INFO; setup сверяет её
  до открытия файла и ALLOC. UGLOAD/UGPLAY при перезапуске карты на этой границе
  возвращают SESSION_CHANGED и сохраняют созданный в новой session чужой объект.
- P1: после DSS read и смены session совпавший LOADING handle мог принять чужие
  bytes и SEAL. Добавлена сверка session непосредственно перед ALLOC, после
  файлового I/O, перед следующими upload/readback blocks и SEAL/тестовым PLAY.
  Отдельный actual-EXE тест проверяет неизменённые bytes/state/uploaded чужого
  LOADING объекта; READY-only тест этого нарушения не обнаруживал.
- P2: DSS-модель исключала queued STOP из projected state при выдаче token и
  могла повторно выдать ещё живой FX ID при wrap. Выдача теперь учитывает реально
  активные instances и принятые PLAY до render boundary, как production C.
  Pending STOP + wrap проверяется независимо в C и DSS-модели.

Функциональные дефекты сначала воспроизведены тестами на прежнем EXE
(lost SEAL удалял READY; FX fault возвращал code=0; UGTEST оставлял pinned loop),
затем исправлены.
Физические измерения остаются REAL_PENDING; S6 сохраняет IN_PROGRESS.
Команды повторной проверки: `s6-package BUILD=build/S6-audit-a`, затем
`s6-package BUILD=build/S6-audit-b` и `s6-compare.py` для этих каталогов.
Результаты: `build/S6-audit-b/REPORT-S6.txt` и
`build/S6-audit-b/REPORT-S6-COMPARISON.txt`.
