# UGCFG: обнаружение и подтверждение SAVE

## Дополнение 2026-10-19: ложное истечение передачи

На стенде подтверждены переключения и FULL (125829120 сравнений, PASS),
но ROUNDTRIP 65536 отказал: GS_DATA — host TIMEOUT (source=01, status=0D),
BULK — card HANDLE (source=02, status=07). Короткие 16-byte оба транспорта
и GS_DATA 1024/1025 прошли. Полная аппаратная приёмка остаётся REAL_PENDING.

Исправлена межъядерная гонка firmware: core1 проверял старый снимок времени
против более нового `transfer.last`, опубликованного core0. Беззнаковое
переполнение выглядело как истёкшие 5 секунд и снимало действующий grant.
Теперь будущая относительно снимка отметка не считается тайм-аутом;
настоящие 5 секунд простоя, включая wrap 32-bit timer, по-прежнему завершают
передачу. Для этой правки требуется новый PGMULTI.UF2.

EXE также изменены. Обновить ZIP/IMG или все используемые EXE из нового
комплекта. При ошибке UGMEM/UGLOAD/UGDUMP печатают `transfer_stage`, `moved`
и `offset` до recovery; stage и исходная длина ответа сохраняются через
CANCEL/INFO/OBJECT_INFO (раньше длина могла относиться к recovery).
Этапы в hex: 01 WRITE_BEGIN, 02 write grant, 03 write data/latch,
04 WRITE_END, 05 READ_BEGIN, 06 read grant, 07 read data/latch, 08 READ_END.
Строка `Transfer recovery` сама по себе не означает ошибку END. Передачи и
потребляющие чтения не повторяются. Пятисекундный общий таймер хоста /SLOW
этой правкой не изменён: на стенде 1024/1025 bytes успели пройти.

После прошивки: GUS → ULTRAGS, INFO/VERIFY, QUICK/FULL; затем
`UGMEM ROUNDTRIP 65536 /SLOW`, `UGMEM ROUNDTRIP 65536`, обе команды с
`/VERIFY`, INFO (objects=0, free=8388608). При успехе повторить оба транспорта
на 8388608 bytes и проверить INFO; только затем продолжить SAVE/power cycle
по последовательности ниже. При отказе сфотографировать полный вывод с
этапом/смещением/счётчиком и INFO, не выполнять SAVE.

Статус: программная проверка HOST/DSS-EXE; **REAL_PENDING**. S7 остаётся
IN_PROGRESS: полный GS 1.05, полная MOD/effect conformance и аппаратная приёмка
не завершены. Этот комплект исправляет конфигурационный обмен, а не закрывает S7.

Обнаружение: CONTROL 01D0h возвращает выбранный selector. Сигнатура DDh читается
из DATA_HIGH 01D2h после unlock CC и подтверждённого выбора 00. Общая процедура
`ugconfig.asm` применяется UGCFG, UG_OPEN и предварительным discovery приложений.
Перед целевым selector выбирается другой безопасный регистр 00/01, чтобы старое
совпадающее echo не принималось за новый выбор. Каждое обращение имеет короткое
ISA-окно с Turbo off; паузы >=158 мкс при 21 МГц выполняются после закрытия окна.
Выбор ограничен тремя секундами DSS и конечным счётчиком при остановившихся часах.
Повторяется только выбор; потребляющие чтения, MODE, REBOOT и SAVE не повторяются.

MODE /SAVE: выбрать режим, один REBOOT, подтвердить новый runtime,
FW_ACTIVE/boot result/INFO API 1.0 и готовность, затем SAVE. Исчезновение карты
может не попасть в опрос; также принимаются смена active/boot result или
новая session ULTRAGS. Перед повторным MODE ULTRAGS session читается только
через собственный INFO при свободном транспорте, с отдельным коротким deadline.
Старый ответ другого клиента не потребляется и не сбрасывается. Ошибка до SAVE не
изменяет сохранённый startupMode. Успешное переключение без SAVE действует до
выключения питания. Перед SAVE проверяется совпадение desired/active и boot result (также для
отдельной команды SAVE), собственный ответ INFO дочитан, транспорт READY.
Предыдущий незавершённый/ошибочный config result запрещает новую запись
(SAVE_NOT_STARTED), чтобы чужой BUSY→OK не подтверждал наш запрос.
Подтверждение SAVE требует наблюдать BUSY, затем OK. Пропущенный BUSY (включая
очень быстрое сохранение), потерянная запись/ответ или тайм-аут дают
SAVE_UNCONFIRMED: Flash могла измениться. Автоматического повтора нет. После
перехода отдельно сообщается, что режим уже активен, а SAVE не подтверждён.
Публичные protocol4/API1.0/Settings/exit codes сохранены. По аппаратному отказу
2026-10-18 исправлен путь firmware: постоянные CONFIG-порты обходят native decode
до утверждения handshake; native ownership также декодируется inline по committed
блокам BASE/ALIAS, без внешнего вызова. Native IOW теперь утверждает IO_WAIT
перед обработкой frame/statistics; IO_END-only здесь был слишком поздним ack.
В HANDSHAKE уже захваченная IOW обслуживается перед последующей IOR; idle RX
не читает таймер на каждой итерации. Native BASE/ALIAS декодируется один раз в
ARM bus handler, а logical register передаётся read/write обработчику; старые
port-based функции оставлены как обёртки. STATUS и consuming INFO используют
короткую decoded-ветку, CRC ответа готовится при dispatch, до чтения DATA.
Конечная инъекция задержки перед IO_WAIT воспроизводит потерю sampled bytes при
продвижении индекса каталога. Это проверка порядка операций, не измерение
физического предела IOCHRDY; арбитраж SRAM и нагрузку I2S/PSRAM она не моделирует.
В HANDSHAKE ULTRAGS отдельная `ug_handshake_ior.pio` сравнивает A5…A9 с
BASE и ALIAS и утверждает IOCHRDY до PUSH/PULL, независимо от core0. Снимок
GPIO пересобирается в исходные A0…A9. PIO также помечает принадлежность
снимка: более поздняя смена BASE не превращает уже прошедшее чужое чтение
в consuming native read. Чужие адреса не растягиваются до решения ARM. При отключённом ALIAS второе сравнение повторяет BASE. CONFIG и низкие
GS aliases сохраняют software handshake. Два SET-immediate обновляются на
idle IOR до IO_END конфигурационной записи, включая DEFAULTS. IOW сохраняет
штатные DACK/ADS/capture и IO_WAIT перед native обработкой; порядок IOW→IOR
проверяется production polling-веткой. PIO0 занимает 32/32 слова. OSR не используется
для адреса: AUTOPULL/PULL barrier не может подменить ответ остатком address.
В native ветке каждое PUSH/OUT/JMP до data continuously side-set IOCHRDY,
поэтому при одновременном завершении IOW старший SM1 сохраняет растяжку.
Generated test исполняет обе SM вместе и отвергает мутацию этого приоритета.

Новый read fuse работает на core1: TIMER_IRQ_2/alarm2, приоритет 00h выше
I2S, опрос каждые 100 мкс, порог непрерывного ожидания 10 мс. Completion latch
PIO0 IRQ flag0 предотвращает ложное срабатывание на серии чтений. Core0 не
должен армировать этот таймер. При срабатывании оба SM отключаются, data pins
переводятся в SIO input, IOCHRDY отпускается, ADS возвращается к адресу до
reboot. Порог — аварийное восстановление, не измеренный ISA timing budget;
маскирование IRQ на core1 во время Flash SAVE может отложить обработчик.
Физический запас IOCHRDY остаётся REAL_PENDING.

ARM comparison можно повторить после сборки GUS и ULTRAGS:

```sh
python3 tools/ultrags/compare-firmware-paths.py \
  --build build/cfg-native-a/multifw-release \
  --objdump arm-none-eabi-objdump --objcopy arm-none-eabi-objcopy \
  --out build/cfg-native-a/firmware-paths
```

Отчёт сравнивает реальные compiled PIO instruction sections с pioasm header и
сохраняет linked ELF disassembly обоих режимов, полный `main` и статически
достижимые вызовы, включая STATUS/response/storage/statistics helpers. Это
позволяет проверить polling loop, decode, timer calls и verdict writes; статический
disassembly не учитывает физическое ожидание ISA и contention.
`pio-isa-check.py` исполняет generated words для 256 карт/262144 адресов,
последовательных INFO с CRC, одинаковых пауз ARM (0…10000 instruction clocks),
полного RX FIFO, DACK и ADS. Старый PIO при задержке возвращает FF, новый
читает весь INFO. `handshake-guard-check.py` исполняет production guard с
register mocks: зависший core0, wrap таймера, последовательные cycles и
постоянное отключение pads. Это программные проверки, не измерения платы.
Оба gate и linked ARM report обязательны для `cfg-package`; упаковка отвергает
отсутствующие или устаревшие доказательства.

`UGCFG` = `UGCFG INFO`; `UGCFG ULTRAGS` = `UGCFG MODE ULTRAGS`.
Поддерживаются `/SLOT:0`, `/SLOT 0`, слот 1 аналогично. По умолчанию слот 0,
автоматического сканирования нет. INFO печатает доступные сведения до проверки API.
`/DIAG` добавляет последний этап (1 identification, 2 catalogue, 3 mode,
4 INFO, 5 SAVE), selector/echo/step, raw magic/protocol/board, заголовок/записи
каталога, stored/computed CRC в little-endian и raw INFO frame. `catalog_error`:
01 header/version, 02 CRC, 03 record structure. Для INFO выводится точное число прочитанных bytes;
ноль означает, что ответ ещё не читался. Короткие ответы с ошибками
дочитываются по объявленной длине и CRC, без чтений за концом. CRC или
недопустимая длина отменяют только собственный frame. Общий boot deadline
проверяется также внутри ожидания selector; остановившиеся часы ограничены
watchdog, включая повторяющиеся корректные INIT ответы. Аппаратного reset из `/DIAG` нет; cleanup может отменить
только незавершённый собственный транспортный обмен. Последняя строка содержит только `RESULT PASS code=0` или
`RESULT FAIL code=N reason=TOKEN`; объяснение и expected/received печатаются перед ней.
Перед native I/O проверяются committed BASE/ALIAS (диапазон/выравнивание/пересечение).
UGTEST загружается с 7800h: объединённый BUS/PROTO/PCM/FX код остаётся ниже B800h;
остальные workspace и стек остаются ниже C000h.

Проверки и повторяемая сборка:

```sh
make -f Makefile.ultrags cfg-package BUILD=build/cfg-native-a
make -f Makefile.ultrags cfg-package BUILD=build/cfg-native-b
```

Нужны SDK/extras/GCC/Python из §13.2.1 ТЗ. В каждом build сохраняются логи,
свежие EXE, `ultrags/cfg-package/ug-cfg.zip`, `ug-cfg.img`, `PGMULTI.UF2`,
`HASHES.TXT` и `manifest.json`. ZIP/IMG содержат одинаковые имена 8.3; hashes
исполненных EXE сверяются с извлечёнными файлами. UF2 поставляется рядом с DSS
диском, потому что установка firmware выполняется отдельно через BOOTSEL/SWD.
PGMULTI проверяется по linked evidence всех семи режимов и bootloader,
по восстановленному BIN и по каждому UF2 header/payload. Повреждение UF2 или
bootstrap не скрывается новым внешним hash manifest.
PGMULTI содержит семь режимов; standalone образ не требуется для этого сценария.

## Tester Notes

### Повторный отказ 2026-10-18: MEMORY_INIT

На присланном стенде GUS проверена, ULTRAGS запускается (active=08), каталог
имеет совпадающий CRC `97 31 C2 F5`, INFO сообщает boot=01/MEMORY_INIT.
Этот прогон **REAL FAIL**, аппаратная приёмка не закрыта. Сбой обмена больше
не является единственным наблюдаемым симптомом; конкретная ошибка PSRAM пока
не выделена одним общим boot-кодом.

В адаптере найден отдельный дефект: READ ID `9Fh` выполнялась на частоте
профиля данных (около 100 МГц), хотя команда ограничена 33 МГц. Исправлено:
для ID временно включается normal PIO и SCK не выше 25 МГц, после окончания
CS восстанавливаются исходные normal/fudge, divider и instruction allocation.
При тайм-ауте исходная программа восстанавливается, SM остаётся выключенным.
Частота обычных данных и fallback normal/fudge сохранены. Основание: AP Memory
[APS6404L-SQN, rev.4.0, §9.5 и §12](https://www.apmemory.com/en/downloadFiles/0324112120g3605268).
Для выпуска с SHA-256 `8259044c5b9f...` это изменение было подтверждено C-моделью;
контрольный стендовый запуск 2026-10-19 снова отказал (см. ниже).

### 2026-10-19: подтверждён отказ READ ID до теста данных

На последней UF2 `8259044c5b9f...` первый GUS → ULTRAGS дал MEMORY_INIT.
INFO/каталог читаются с правильной CRC; physical/pool/free=0.
Новый диагностический UGMEM показал `rpc_source=02 status=13 response_bytes=0E`,
`tested=0 first_bad=FFFFFFFF expected=00 actual=00 elapsed_ms=0`.
Повтор QUICK без выключения не восстанавливает память. Status 13h —
UNSUPPORTED_MEMORY: отказ идентификации до сравнений адресов/данных.

Найден второй дефект: стандартная PSRAM PIO предназначена для FAST READ и
выдаёт дополнительный SCK перед первым IN. Для READ ID без dummy cycles он
сдвигает результат на один бит. На <=25 МГц это уже не скрывается задержкой
MISO. Исправлено отдельной `ug_psram_id.pio`: 9 слов, 32 command/address +
24 read clocks, без лишнего такта. Читаются три используемых probe байта
MFID/KGD/EID. CS low около 2,3 мкс укладывается и в ограничение 3 мкс для
extended-temperature PSRAM; три RX слова помещаются в FIFO даже при задержке
запуска RX DMA обработчиком IRQ. До/после ID остаются те же checks CS/idle,
остановка SM, замена единственной программы и восстановление data profile.
Программа обычных данных GUS/ULTRAGS не менялась.

Новый обязательный `psram-id-check.py` запускает pioasm, сверяет header и
compiled instruction sections, исполняет реальные слова с цифровой моделью
fig.13 даташита. Для трёх байтов старый движок даёт 57 тактов и ID `1A BA ...`;
новый: 56 тактов,
ID `0D 5D 40 ...`. 768 вариантов ID/задержки MISO. Это HOST evidence,
функциональное подтверждение на карте ещё требуется. REAL_PENDING, S7 IN_PROGRESS.

**EXE теперь изменены:** обновить утилиты из нового ZIP/IMG. UGMEM при ошибке
печатает сохранённые source/status/response length без дополнительных чтений
карты и без повтора consuming reads; exit codes, CLI и /QUIET сохранены.
Полученный ранее диагностический UGMEM.EXE уже содержит этот вывод.

После новой UF2 выполнить `UGCFG ULTRAGS`, затем `UGCFG INFO /DIAG` и
`UGMEM INFO` в том же `/SLOT`. При MEMORY_INIT также сохранить полный вывод
`UGMEM TEST QUICK` (хранилище при неудачном старте пустое). SAVE выполнять
после успешного INFO/VERIFY и проверки памяти, как указано ниже.

Установить PGMULTI.UF2 из этого комплекта. Записать тип PicoGUS, BIOS/DSS,
ISA slot, аппаратное разрешение Turbo, SHA-256 UF2/EXE из HASHES.TXT.
**В этом выпуске нужны новая UF2 и EXE из нового ZIP/IMG:** исправлены native
IOR/IOW ULTRAGS и READ ID PSRAM; добавлен подробный вывод ошибок UGMEM.
S7-review (UF2 SHA-256 `6f8731d4596bab5d00eb919b4fe1f75bb206edaa29233d2e347e229f43bcf3ce`)
и cfg-card-failure (`7b3a05fabd7ea5c4666e26674faab444b87be36f98397807cde25d5fcaa5278f`)
не содержат этой правки. Первый fix исправил каталог на стенде, но INFO
продолжал терять байт длины: `00 FF` вместо `00 24`.
Обновить также DSS EXE из нового ZIP/IMG и зафиксировать новые hashes.
Полный функциональный прогон на Sprinter (для второго слота добавлять
`/SLOT 1` ко всем командам):

```text
UGCFG GUS
UGCFG
UGCFG LIST
UGCFG ULTRAGS
UGCFG
UGCFG VERIFY
UGCFG
UGCFG VERIFY
UGMEM INFO
UGMEM TEST QUICK
UGMEM TEST FULL
UGMEM ROUNDTRIP 65536 /SLOW
UGMEM INFO
UGCFG SAVE
```

После каждой команды нужен `RESULT PASS`. До SAVE ожидаются protocol=04,
active=08 ULTRAGS, boot_result=00, API=1.0, стабильные BASE/ALIAS. На штатной
плате physical/pool/free=8388608, objects=0. TEST требует пустое хранилище;
FULL проверяет все адреса 15 шаблонами (125829120 сравнений), first_bad=FFFFFFFF.
ROUNDTRIP обязан освободить временный объект и вернуть исходную free memory.
При любом отказе прекратить последовательность до SAVE, сохранить DIAG/RESULT.

SAVE должен отдельно подтвердить запуск и завершение. Затем выключить питание
Sprinter/PicoGUS, включить и выполнить:

```text
UGCFG
UGCFG VERIFY
UGMEM INFO
UGCFG GUS
UGCFG
```

После power cycle первые INFO/VERIFY должны подтвердить ULTRAGS; последняя
команда — активный GUS. Сохранить вывод и hashes фактически установленных UF2/EXE.
При `UGCFG INFO /DIAG` полный INFO имеет 42 bytes (`2A`), начало `00 24`,
корректную CRC. LIST проверяет общий каталог и сам по себе не подтверждает
native transport. Повторить со входным Turbo on/off, аппаратным запретом Turbo
и ESC. До функционального прогона статус — REAL_PENDING, S7 — IN_PROGRESS.

При отказе: `UGCFG INFO /DIAG` и `UGCFG LIST /DIAG` на том же слоте.
Сохранить оба вывода до перезагрузки. Меняющиеся позиции FF среди правильных
байтов UGCF/records означают повреждённое чтение, а не доказанное отсутствие
каталога. INFO сохраняет доступные сведения, но при известном active mode и
невалидном каталоге теперь завершает RESULT FAIL code=3; старый legacy без
расширений по-прежнему допускает read-only INFO.
В `config read/base/alias` первый байт 00 означает, что порты ещё не читались;
значения по умолчанию вместо аппаратных данных не печатаются. При 01 следуют
четыре реально прочитанных байта BASE/ALIAS в little-endian.
При SAVE_UNCONFIRMED не запускать автоматические повторы: сохранить диагностику,
проверить активный режим; холодный старт показывает, что действительно сохранено.
Повторить с Turbo on/off при входе и аппаратном запрете Turbo; проверить ESC.
До успешного повторного прогона на карте итог остаётся **REAL_PENDING**.
