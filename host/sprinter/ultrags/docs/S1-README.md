# S1: standalone ISA diagnostic

Статус программных проверок: **HOST_PASS / DSS-EXE_PASS / REAL_PENDING**.
C00 и электрические gates не приняты. Этот образ — standalone, Flash origin
`0x10000000`; он не является mode8, не входит в multifw и не переключается UGCFG.
Common protocol4, EXT API и прошивки прежних режимов не изменены.

## Сборка и артефакты

Закреплены SDK 2.1.1, pico-extras sdk-2.1.1, Arm GCC 14.2.Rel1, sjasmplus
1.22.0, Python 3.13 и пакеты `tools/ultrags/requirements-build.txt`, CMake >=3.29.
Точные revisions/лицензии: `tests/ultrags/reference/sources.json`.
Пример для текущего workspace:

```sh
export PATH="/Users/dmitry/dev/zx/sprinter/toolchain/armgcc/bin:$PATH"
export PICO_SDK_PATH=/Users/dmitry/dev/zx/sprinter/toolchain/pico-sdk
export PICO_EXTRAS_PATH=/Users/dmitry/dev/zx/sprinter/toolchain/pico-extras
export UG_PYTHON=/Users/dmitry/dev/zx/sprinter/toolchain/py313/bin/python3
make -f Makefile.ultrags s1-package
make -f Makefile.ultrags s1-package BUILD=build/S1-review \
  UG_PICOTOOL_SEED="$PWD/build/tools/picotool/source"
```

`s1-check` выполняет S0a/S0b regression, настоящий C front-end/guard под SDK
mocks, actual-EXE harness, fixtures/excerpt/package self-tests, diagnostic
PGDEBUG OFF/ON и no-DACK, MULTIFW и NE2K, SRAM/Flash/PIO budgets и printf leakage.
`s1-package` дополнительно создаёт `build/ultrags/s1-package/ug-s1.zip` и
`ug-s1.img`, независимо извлекает ZIP/FAT12 и сверяет EXE с исполненными bytes.
Прошивки находятся отдельно в `s1-package/standalone/` с manifest SHA-256.
Link-time evidence связывает ELF с фактическими compiler dependencies и конфигурацией;
упаковка отвергает устаревшие исходники. UF2 проверяется по family RP2040,
последовательности блоков, адресу и совпадению payload с BIN. Обычные сборки явно
задают DACK gate ON независимо от прежнего CMake cache.
Свежий review tree имеет те же пути внутри `build/S1-review/`.

Generated headers, EXE, firmware, logs, JSON, manifests и captures находятся
только в ignored `build/`. Агент не выполняет staging, commit или push; существующий индекс сохраняется.
`ST-*.EXE` — намеренно дефектные harness-программы; на стенде их не запускать.

## Backup, установка и recovery

Все команды этого раздела предназначены для будущего стенда и **не выполнены**.
Перед записью сохранить **все 2 MiB Flash**, включая Settings в последнем секторе,
или получить явное согласие владельца на потерю установленного bundle/settings.
Копия только исходного bundle не сохраняет текущие settings.

Закреплённый picotool: revision
`ba3df406c37774144a059b2bdae73ab52587a1d2`, вывод версии
`v2.3.2-develop`. Обычный build-инструмент собран без USB и не умеет save/load.
Для backup/recovery нужна отдельная USB-сборка той же ревизии (на этом host
libusb 1.0.29; команда сборки и справка save/load проверены):

```sh
cmake -S build/tools/picotool/source -B build/tools/picotool-usb \
  -DCMAKE_BUILD_TYPE=Release -DPICO_SDK_PATH="$PICO_SDK_PATH" \
  -DPICOTOOL_NO_LIBUSB=OFF -DPICOTOOL_FLAT_INSTALL=1
cmake --build build/tools/picotool-usb --parallel
build/tools/picotool-usb/picotool version
build/tools/picotool-usb/picotool help save
build/tools/picotool-usb/picotool help load
```

Выключить Sprinter. Подключить PicoGUS к USB, удерживая BOOTSEL. Проверить питание
и разводку конкретной платы; не подавать несовместимые источники питания вместе.
На единственной подключённой RP2040:

```sh
mkdir -p build/real/backup
build/tools/picotool-usb/picotool save -a -v build/real/backup/before.uf2
shasum -a 256 build/real/backup/before.uf2
build/tools/picotool-usb/picotool info build/real/backup/before.uf2
build/tools/picotool/install/picotool/picotool info \
  build/ultrags/s1-package/standalone/pg-diag-release.uf2
# Только после backup либо согласованной потери:
build/tools/picotool-usb/picotool load -v -x \
  build/ultrags/s1-package/standalone/pg-diag-release.uf2
```

Альтернатива установки после backup: в BOOTSEL скопировать UF2 на mass-storage
том `RPI-RP2` (macOS: `cp <diagnostic.uf2> /Volumes/RPI-RP2/`). Диагностический
UF2 имеет family RP2040 и origin `0x10000000`; slot-linked ELF не устанавливать.
Не использовать mass-storage том для чтения установленной Flash: она там не видна.

Recovery: при зависшем ISA **выключить питание хоста**, загрузить BOOTSEL вне
зависшего Sprinter и вернуть full-flash backup:

```sh
build/tools/picotool-usb/picotool load -v -x build/real/backup/before.uf2
```

Если backup утрачен и потеря settings согласована, установить проверенный штатный
bundle `build/multifw-release/picogus.uf2`, затем проверить его конфигурацию.
SWD — альтернативный recovery по документации платы/закреплённого OpenOCD;
этот S1 не выполнял SWD и не заявляет его проверенным способом.

## DSS команды

Все имена и ключи case-insensitive. Слот выбирается явно (default 0); сканирования
нет. `/BASE:02A0` — единственная база этой standalone сборки. Другой адрес
отклоняется до bus access. Decimal числа допускают `0x`; BASE всегда hex.
Все ISA-окна принудительно работают с Turbo off; при закрытии включается Turbo DSS.
`/CPU:21`, `/CPU:3.5`, `/CPU:UNKNOWN` сохранены; все ограничены chunk8.
Исходный режим не определяется. См. [ISA-TURBO.md](ISA-TURBO.md). BLOCK задаёт grant1..1024,
независимо от размера chunk. STACK запрещён при неизвестном NMI-контракте.

```text
UGTEST BUS /REAL /SLOT:0 /CPU:21
UGTEST BUS /REAL /SLOT:1 /CPU:3.5
UGTEST BUS /REAL /SLOT:0 /CPU:21 /MIRROR
UGBENCH /BYTES:65536 /LOOPS:4 /BLOCK:256 /METHOD:ALL /CHECK:BOTH /CPU:21
UGBENCH /BYTES:65536 /LOOPS:4 /BLOCK:512 /METHOD:FIXED /CHECK:BOTH /CPU:21
UGBENCH /BYTES:65536 /LOOPS:4 /BLOCK:1024 /METHOD:FIXED /CHECK:BOTH /CPU:3.5
UGBENCH /ASSERT:10 /RESPONSE:50 /BYTES:4096 /LOOPS:1 /CPU:21
UGBENCH /SOAK:65 /SPIKE:1 /CPU:21
UGBENCH /SOAK:65 /SPIKE:2 /CPU:3.5
```

`/MIRROR` является явным подтверждением **изолированного стенда**. Только с ним
проверяется C6A0h→C2A0h; без него высокое зеркало не трогается. Проверить отсутствие
конфликтов native 02A0h..02A4h и config 01D0h..01D2h перед любым REAL запуском.

UGTEST проверяет magic DD, protocol4, диагностическую version3 и standalone
mode0 до первого native access, затем pattern/echo, счётчики и новую session.
Он передаёт 1 048 576 bytes записи, 1 048 576 echo-чтения и ещё 1 048 576 pattern
чтения. Ошибки порядка, потери/дублирования и аварийный flag приводят к FAIL.

UGBENCH реализует SRAM FIXED write/read. METHOD:ALL запускает FIXED и сообщает
SKIP SLOW (S1 SRAM only), ALIAS (S5 pending), STACK (NMI unknown). Явно указанный
неподдерживаемый метод возвращает code3 до ISA access. CHECK:NONE сравнивает bytes
в контрольном проходе каждого блока вне timed phases; CHECK:CRC включает CRC32 и
сравнение в timed phases; BOTH выполняет оба профиля. WRITE проверяется echo,
READ — последовательным pattern. После каждого блока сверяются независимые
счётчики firmware. По умолчанию bytes65536, loops4, block256, BOTH directions/checks.
ESC и DSS clock/print вызываются только с закрытым ISA-окном. SOAK — секунды;
застывшие часы имеют конечный polling fallback и возвращают timeout.

Вывод ASCII: direction1=write/2=read, check_crc0/1, hex bytes и секунды
setup/data/finalize/total, block/chunk, служебные accesses. total — сумма timed
phases, исключающая контрольный NONE pass и counters/ESC. Часы DSS имеют разрешение
1 s; phase numbers являются грубыми оценками. `timing_error_bound_seconds`
равен числу измеренных непересекающихся интервалов: ошибка их суммы строго меньше
этого числа секунд при работающих часах. Скорость печатается только если total
не меньше пяти таких границ (максимальная погрешность <=25%). Иначе интервал обозначен
`SPEED=INSUFFICIENT_INTERVAL`; для оценки скорости требуются длительные повторения
и отдельная фиксация погрешности измерений. Harness T-states не являются REAL speed.
`/QUIET` подавляет benchmark rows, последняя RESULT строка остаётся обязательной.

Exit codes: 0 PASS, 1 syntax, 2 absent/wrong mode, 3 diagnostic API/unsupported
method, 8 timeout, 9 verification, 10 cancel; 7 — SPIKE audio fault; остальные §11 не используются здесь.
После любой ошибки после идентификации grant отменяется, включая MIRROR;
принятый этой программой spike получает best-effort STOP. ISA/MMU/IFF/SP восстанавливаются. NO-DACK variant
тоже распознаётся: bus flags bit1 сообщает вариант и не является ошибкой.

## Приватный интерфейс и измерения

Источник C/ASM constants — `tools/ultrags/diag-schema.json`, generated только в build.
Selectors 80h/81h/82h сохраняют spike status/command/quanta. Version3 добавляет:
83h version; 84h BASE low/high; 85h coherent 28-byte bus snapshot; 86h assertion
и 87h response delays, staged low/high microseconds0..1000. CLI `/ASSERT:N /RESPONSE:N` задаёт эти microseconds и автоматически уменьшает
chunk для длинных задержек; snapshot также читается по коротким chunks.
Слишком большое значение
отклоняется и сохраняет прежнюю задержку. Чтение snapshot насыщается, не wrap.

Native BASE+0=data, +1=command/status (80h=sticky error), +2/+3=block length LE,
+4=latch/write, snapshot stream/read. Commands1=WRITE, 2=ECHO последнего полностью
завершённого блока той же длины, 3=PATTERN, 4=END, 5=session RESET, 6=CANCEL.
Новая WRITE сразу инвалидирует старый ECHO; CANCEL и неполный END не позволяют
прочитать частично перезаписанный блок. RESET session не сбрасывает MCU/IRQ guard. Pattern `(7+13*i)&255` непрерывен отдельно
для записи и чтения, сбрасывается session RESET. Snapshot: session/written/read/
errors/blocks u32 LE, position/length u16, state/flags u8, reserved2.
flags bit0=fatal guard, bit1=no-DACK. Все snapshots immutable после select/latch.

Finite-delay guard: hardware alarm2, IRQ на core1 priority00 выше I2S40;
5 ms аварийный предел, без зависимости от core0 loop. Diagnostic PIO флаги0/1
фиксируют завершение read/slow-write и защищают от ложного срабатывания на поздний
чужой цикл. При аварии оба ISA SM отключаются, AD pins переводятся в input/SIO,
IOCHRDY отпускается, ADS возвращается к адресу. Обмен не продолжается до reboot.
Guard не делает произвольное зависание до распознавания адреса безопасным:
его scope — собственные распознанные циклы, в том числе injected delays.
Аппаратная проверка tri-state и уровней обязательна. PIO IRQ выключены; флаги
не включают PIO IRQ. Две PIO-программы занимают 21/32 words; нормальный DACK gate
и no-DACK собираются раздельно. Общий `sw/isa/isa_io.pio` не изменён.

`/SPIKE:1|2` запускает existing core1 profile на 24000 quanta (64 s при48k):
8+4 mono или8+2 stereo, real PSRAM cache fills, background write/read, I2S DMA.
SOAK одновременно даёт ISA SRAM traffic; synthetic ISA traffic создаёт именно
DSS host. Status v3 (92 bytes) публикуется через80h: clocks/quantized dividers,
nominal SCK/LRCLK, frames/quanta, render maximum, underruns, cache/fetch/data errors,
resource audit, wall elapsed_us. `SPIKE_STATUS_V3 raw_le_words=` содержит 23 u32
из coherent packed record; layout — `sw/ultrags/ug_diag.h`. Частоты nominal;
физические SCK/LRCLK измерять отдельно. Статус — диагностическое evidence, не C00 PASS.

## REAL gate и отчёт стенда

Для каждого board revision, slot0/1, CPU21/3.5 записать BIOS/DSS revisions,
NMI-contract, DACK INVERT/RDACK/channel jumpers, /DACK на ISA и GPIO19 в idle/write,
pulls и отсутствие конфликтов. Нельзя советовать GPIO19 pull-up: высокий уровень
подавляет IOW. При неопределённом DACK испытать отдельно no-DACK UF2; проверить
ложные записи/соседние карты. По умолчанию gate включён.

Logic analyzer: IOR/IOW, IOCHRDY на разъёме и GPIO26, AD/data-driver OE/tri-state,
ADS/BUSOE, IRQ21, RESET DRV/RUN, GPIO19 и ISA /DACK, SCK, LRCLK. Проверить IRQ inactive,
ADS init, RESET→MCU reboot/new host session, восстановление DSS после теста,
безопасный NMI во всех открытых окнах. Для STACK одного DI недостаточно.

С контролируемыми read и slow-write задержками измерить возрастающий **конечный**
ряд assertion/response. Записать точки измерения, полярности, raw traces, uncertainty.
Не искать предел зависанием Z80 и не заменять измерения нормой PC ISA2500ns.
Предохранитель проверить отдельной fault injection на изолированном стенде;
после аварии требуется выключение/recovery. Не выполнять аварийные ST-EXE на карте.

Из §3.5.3 получить T_ready_validated_ns, T_assert_validated_ns, T_assert_max_ns,
fence_latency_max_ns, T_read_tail_max_ns, T_hold_max_ns. С погрешностью U проверить:

```text
budget = floor(0.75 * T_ready_validated_ns)
fence_latency_max_ns + T_read_tail_max_ns + U <= budget
T_hold_max_ns + U <= budget
T_assert_max_ns + U <= floor(0.75 * T_assert_validated_ns)
```

Замеры — под конкурирующими I2S/PSRAM DMA. Для handshake записать capture→SRAM→ack,
worst polling hiatus, T_gap_min, каждый byte/million counters и повторяемость;
posted FIFO/backlog0..8 остаётся S5, этот diagnostic не заявляет его реализацию.
DI цель <=2 ms, обязательный предел <10 ms, chunk выбирается отдельно для CPU
с запасом25%; номинальные harness windows не доказывают электрический предел.

C00 принимать только по REAL runs >=60 s **на каждом** spike profile: worst
render <=2000 us (75% quantum128/48k), underruns/fetch/bg/data errors0, resource audit0,
сохранённые SCK/LRCLK и ISA traces. Приложить точные UF2/EXE hashes из этой поставки,
температуру/маркировку PSRAM, clock dividers, cache metrics, CPU/slot/jumpers,
измерения всех inequalities и uncertainties. До этого REAL_PENDING; S1 не ACCEPTED.

Spike command acceptance и coherent snapshot BUSY проверяются с конечными retry,
ESC и timeout; RUN/DONE должны относиться к запрошенному профилю. Snapshot с ERR,
underruns/fetch/bg/resource errors либо без успешного audit возвращает code7.
Короткий `/SPIKE` запуск публикует промежуточный snapshot и оставляет синтетический
run работать до его конечного default64s; это не приёмка C00. При ошибке программа
пытается остановить только запущенный ею run. Для REAL C00 использовать SOAK >=65s
и подтвердить DONE/duration и все численные критерии по полному snapshot/captures.

В штатный actual-EXE suite входят million-byte BUS в обоих слотах на21/3.5MHz;
короткая матрица каждого CPU/slot проверяет оба исходных IFF (EI и DI).
HOST проверяет отмену/неполный WRITE и fatal во время assertion чтения/slow-write.
