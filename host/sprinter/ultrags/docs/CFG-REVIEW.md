# Кодревью UGCFG и проверка плана

Дата: 2026-10-18. Аппаратная приёмка **REAL_PENDING**; S7 **IN_PROGRESS**.
Результаты конкретной сборки, версии и hashes находятся в её `REPORT.TXT`,
`HASHES.TXT`, `CFGTEST.JSN`, `MATRIX.JSN`, `TURBO.JSN` и `CTRACE.JSN`.

Повтор на карте после первого исправления: LIST и каталог стали корректны,
ULTRAGS VERIFIED, boot_result=0, runtime CRC `4A B1 E4 1C` совпадает с
cfg-card-failure. INFO получает `00 FF` вместо `00 24`; этот установленный
комплект не прошёл G0. Позднее исправление CONFIG dispatch было добавлено отдельно.
В актуальном коде native register определяется один раз в ARM bus handler и
передаётся decoded обработчику. Оба port-based API сохранены. Native IOW
утверждает IO_WAIT до frame/statistics, затем IO_END; POSTED verdict остаётся
no-op. Полные IOW/IOR выполняются с production ug_minimal.c: INFO request/dispatch,
consuming reads и CRC; storage hooks замоканы. Мутации позднего decode и
отсутствующего write handshake обнаруживаются. Новый ARM report сохраняет
linked polling-loop/callee disassembly и сравнивает compiled PIO bytes обоих
объектов с pioasm output. Это не моделирует contention и не является численным
физическим timing. Раннее PIO распознавание BASE/ALIAS и независимый core1
read fuse добавлены при повторном ревью; PIO0: 32/32 слова.

Дополнение по физическому отказу 2026-10-18: на установленном S7-review UF2
(`6f8731d4596bab5d00eb919b4fe1f75bb206edaa29233d2e347e229f43bcf3ce`) GUS
читает каталог, после MODE ULTRAGS среди правильных bytes появляются FF,
позиции меняются между INFO/LIST; boot result тоже может читаться как FF.
Это не отсутствующий каталог. Старый HOST trace исключал native decode и
не мог воспроизвести позднюю растяжку. Теперь исполняется полный production
handle_ior с SOUND_ULTRAGS и настоящий bundled ug_runtime_init. Конечная
инъекция задержки native decode теряет sampled bytes, сохраняя продвижение
индекса; mutation прежнего порядка должна завершаться отказом.

Исправлен firmware dispatch: фиксированные CONFIG-адреса обслуживаются до
native decoder, HANDSHAKE сохраняет порядок IOW перед IOR, idle poll не обращается
к таймеру без незавершённого RX. Другие режимы сохраняют прежний dispatch.
INFO при известном active и повреждённом каталоге больше не выдаёт RESULT PASS;
доступные сведения и DIAG сохранены. Нельзя повторять потерянные consuming reads.
В этот раз требуется новый UF2 и EXE. Реальная причина позднего чтения и запас
по времени проверяются повтором на карте/измерением IOCHRDY; HOST injection
не считается измерением. Первоначальный аппаратный сценарий не прошёл,
исправленная поставка остаётся REAL_PENDING; S7 IN_PROGRESS.

При ревью обнаружены и исправлены следующие дефекты предыдущей реализации:

1. INFO всегда читал 42 bytes: короткий error frame давал лишние consuming reads,
   длинный frame оставлял непрочитанный хвост. Теперь читаются header, объявленный
   payload и CRC; status/length/CRC/identity различаются. Недостоверная граница
   отменяет собственный transport. Чужой REPLY остаётся нетронутым.
2. Быстрый reboot, целиком попавший между опросами, ошибочно завершался timeout.
   Теперь смена active/boot result подтверждает новый runtime. Для same-mode
   ULTRAGS используется проверенная новая session; игнорированный REBOOT с прежней
   session не принимается за успех. Ни REBOOT, ни MODE/SAVE не повторяются.
3. Общий deadline проверялся только после выбора регистра. Ожидание selector теперь
   проверяет внешний boot deadline и ESC между короткими ISA-секциями. Отдельный
   watchdog ограничивает также повторяющиеся корректные INIT/session INFO frames
   при остановившихся часах.
4. INFO перестал показывать API/build, а RESULT содержал целое предложение вместо
   reason token. API/build восстановлены, объяснение/expected/received вынесены
   перед заключительной строкой. Каталог помечается как прочитанный/непрочитанный,
   INFO показывает фактическое число bytes; структурная ошибка показывает record.
5. Committed BASE/ALIAS не проверялись перед native I/O. Некорректные диапазон,
   выравнивание и пересечение теперь дают CONFIG_PORTS до обращения к native ports.
6. Проверка поставки доверяла UF2 и bootstrap, проверяя только соседние mode
   artifacts. Теперь проверяются восемь link records (bootstrap + seven images),
   карта Flash/каталог, восстановленный BIN и точные UF2 headers/payload. Отдельные
   negative tests подменяют UF2/BIN/bootstrap/catalogue/slot map. Финальный
   package writer сам проверяет source/build/execution/ZIP/IMG freshness.
7. Модель diagnostic неправильно меняла selector при повторном unlock CC.
   Исправлена семантика unlock. Differential trace дополнен production HWTYPE,
   его provenance содержит реальные C headers всех compilation units.

Проверка исходного плана:

| Требование | Реализация и проверка |
|---|---|
| Magic через 00/1D2, CONTROL только echo | Общий `ugconfig.asm`; actual-EXE mutation с неверным портом отвергается |
| Подтверждение select, паузы >=150 мкс, 3 s/watchdog | Раздельные окна, закрытая пауза 158 мкс при 21 МГц, delayed/lost/stuck selector tests |
| Только безопасный select можно повторять | Mode/reboot/save counters; consuming reads считаются отдельно |
| PAGE3/IFF/Turbo/ABI/память ниже C000 | Assembly assertions, invalid slot/session tests, полная actual-EXE context matrix |
| Protocol4/API1.0/Settings/команды | Firmware contract и Settings не меняются; production C/model differential |
| MODE -> один REBOOT -> verify -> SAVE | Flash не запрашивается при fallback/API/memory/audio/CRC/ready failure |
| Завершить собственный INFO, подтвердить SAVE | Exact response boundary, READY, прежний config result, BUSY -> OK; dropped/error/timeout cases |
| Не повторять неопределённый SAVE | SAVE_UNCONFIRMED и один save request; отдельно показан уже активный режим |
| INFO/ошибки/DIAG | Доступные common поля до API; ASCII причины, raw данные и CRC; без аппаратного reset |
| CLI и LIST/help | Default INFO, mode shortcut, обе формы SLOT, default slot0/no scan, mode names/examples |
| Реальная семантика моделей | CONTROL echo, magic DATA_HIGH; production branches + actual MULTIFW catalogue, headers pinned |
| Отказы/задержки/старые данные/Flash/power cycle | Negative frames/selectors, unowned reply, fast reboot, fallback, SAVE failure/loss, stopped clock/ESC, GUS <-> ULTRAGS cycles |
| Свежие EXE/ZIP/IMG, hashes и 8.3 | `cfg-package`, independent extraction/tamper/repeat tests, execution byte identity |
| Hardware workflow и статус S7 | Русские Tester Notes; реальный power cycle/ISA/audio ещё REAL_PENDING; S7 не закрывается |

Повторение программного gate:

```sh
make -f Makefile.ultrags cfg-package BUILD=build/cfg-native-a
```

Использовать SDK/extras/GCC/Python из §13.2.1 ТЗ. Для отдельной проверки целостности
firmware bundle: `python3 tests/ultrags/unit/test_cfg_bundle.py --build build/cfg-native-a`.
Физические IOCHRDY/PSRAM/LRCLK и загрузку после выключения питания подтверждает
только прогон Tester Notes на Sprinter с теми же UF2/EXE hashes.

## Ревью оптимизации ULTRAGS относительно GUS

Найдены и исправлены дополнительные замечания:

1. **P1: нарушен порядок IOW→IOR.** Прежний приоритет чтения обслуживал STATUS
   до уже захваченного последнего byte команды. Восстановлена обработка IOW
   перед IOR; mutation реального polling-кода обязана провалиться.
2. **P1: PIO early wait отсутствовал.** Добавлена отдельная IOR-программа только
   для HANDSHAKE ULTRAGS, с BASE/ALIAS match до FIFO stall. Сравнения обновляются
   до подтверждения CONFIG/DEFAULTS. PIO tag сохраняет принадлежность захваченного
   адреса при последующей смене карты; чужое чтение не потребляет INFO. Core1
   read fuse действует при зависшем core0.
3. **P1: задержка проверялась только в старой мутации.** Теперь та же инъекция
   применяется и к новой ветке; без раннего PIO ожидания INFO снова теряет length.
   Отдельно исполняются generated PIO words: старый FF / новый полный INFO + CRC.
4. **P2: ARM report не покрывал leaf functions.** Object disassembly содержал
   неразрешённые вызовы и пропускал ug_minimal/storage/statistics. Теперь отчёт
   берёт linked ELF, полный main и достижимые callee; STATUS и response имеют
   прямые entry points, обёртки совместимы (включая unmapped read=0 и приоритет
   transport error), release/acquire и consume сохраняются.
5. **P2: отчёт был необязательным для поставки.** Linked ARM, PIO matrix и core1
   fuse включены в cfg-check; package writer отклоняет missing/stale evidence.
6. **P1: AUTOPULL/PULL и владение OSR.** Первая PIO-ветка декодировала адрес
   через OSR, а PULL при неистощённом OSR является barrier/no-op. Адрес теперь
   декодируется через ISR/X; OSR принадлежит только verdict/data. Модель проверяет
   documented refill/stall/PULL semantics, а не предполагает очистку OSR.
7. **P1: совместный IOCHRDY двух SM.** IOW cleanup мог снять раннюю растяжку IOR.
   Native PUSH/OUT/JMP имеют side-set на каждом stalled clock, SM1 приоритетнее
   SM0. Добавлено совместное исполнение generated IOW+IOR и отрицательная мутация.

Семантика сверена с [RP2040 datasheet](https://datasheets.raspberrypi.com/rp2040/rp2040-datasheet.pdf),
§3.4.7.2, §3.5.4.2 и §3.5.6.1. Отчёт повторно запускает pioasm и отвергает
stale header; затем сверяет header с compiled instruction sections.


| Пункт плана оптимизации | Состояние и доказательство |
|---|---|
| Собранные ARM GUS/ULTRAGS, polling/calls/timer/PIO verdict | Linked ELF + call closure + compiled instruction sections; численный physical SRAM arbitration не заявлен |
| Одно native decode, совместимые port API | ARM передаёт logical register; exhaustive decoder equivalence |
| Прямые STATUS/INFO, CRC до REPLY, consume один раз | Dedicated functions; production framing + actual EXE счётчики |
| Ранние BASE/ALIAS, чужие порты, смена карты до ack | Generated PIO: 256 карт × 1024 адреса; production map publication test |
| IOW порядок/DACK/ADS/data release, независимый fuse | Production polling mutation; generated IOW; core1 guard register tests |
| Одинаковая ARM delay: old FF / new INFO CRC | Generated opcode execution и production C injection; finite pauses, full RX FIFO |
| I2S/PSRAM | HOST/DSS storage/audio regression и модель пауз ARM; реальный contention/IOCHRDY — REAL_PENDING |
| Оба слота, PAGE3/IFF/Turbo, ESC, timeout, consume/SAVE | Actual EXE CFG/Turbo/full UGDIAG regression; Turbo 2→ISA→3 сохранён |
| Две независимые поставки, EXE из ZIP/IMG, hashes | Независимые build/assembly; package provenance/extraction/tamper gates |
| Функциональный прогон карты | REAL_PENDING; S7 IN_PROGRESS |

Software evidence не закрывает электрические и функциональные REAL gates.

## Повторный аппаратный отказ: PSRAM READ ID

Фото владельца от 2026-10-18: GUS VERIFIED; ULTRAGS active=08, boot=01;
CRC каталога stored/computed `97 31 C2 F5`; INFO целиком прочитана и сообщает
MEMORY_INIT. Зафиксирован REAL FAIL; общий REAL gate остаётся REAL_PENDING,
S7 IN_PROGRESS. Это не подтверждение исправности обмена под всеми нагрузками.

**P1, исправлено в коде:** `ug_psram_read_id()` передавала `9Fh` с делителем
обычных данных (~100 МГц SCK). В AP Memory
[APS6404L-SQN rev.4.0 §9.5/12](https://www.apmemory.com/en/downloadFiles/0324112120g3605268)
для READ ID указан предел 33 МГц. GUS не выполняет эту идентификацию, поэтому
успешная GUS не исключает данный дефект ULTRAGS. READ ID теперь временно
использует normal sampling и <=25 МГц. Переключение только при idle/CS high,
после остановки SM и освобождения старой PIO-программы; после завершения
восстановлены исходные program/wrap/divider и allocation. При отказе SM остаётся
выключенным; recovery явный. Хранимые данные не сбрасываются, ресурсная карта,
профиль чтения/записи данных и normal/fudge fallback сохранены.

Pinned backend regression проверяет READ ID в обеих фазах и профилях 50/100 МГц,
при 264/370 МГц sysclk, с ненулевым program offset/соседними программами,
восстановление после тайм-аута. Старый adapter нарушает проверку частоты/фазы.
Контрольный повтор на карте необходим: по общему MEMORY_INIT нельзя доказать,
что именно READ ID вызвала этот конкретный отказ. EXE не изменены.

## 2026-10-19: READ ID, лишний такт и недостаточная модель

Контрольный повтор UF2 `8259044c5b9f...`: MEMORY_INIT и пустой pool.
Диагностический UGMEM на неизменённой включённой карте подтвердил status=13h,
payload=14, tested=0; повтор QUICK снова отказал. Это локализует отказ в ID,
а не в сравнении адресов/данных. Стабильность ISA под нагрузкой этим не доказана.

**P1, исправлено:** прежний `id_profile` снижал частоту, но ставил обычную
FAST READ PIO, у которой перед первым IN есть дополнительный SCK. READ ID
начинает MFID сразу после 24 address bits (AP Memory fig.13). На низкой
частоте получался сдвиг ID на бит; предыдущий byte-level C mock без PIO
автомата возвращал готовый ID и пропускал дефект. Теперь для ID отдельная
9-word PIO: 56 SCK для 32-bit command/address и трёх используемых байтов
MFID/KGD/EID. Та же длина через старый движок требует 57 SCK. Короткий ID
также укладывается в 3 мкс CE-low extended-temperature parts при <=25 МГц;
RX FIFO вмещает все три байта, если IRQ задержал запуск RX DMA.
Данные читаются прежним normal/fudge движком; единственная SPI программа
переключается на прежнем offset при остановленном SM и CS high.

`psram-id-check.py` — обязательный gate упаковки: fresh pioasm против headers,
три compiled instruction sections против generated words, 768 вариантов
цифрового ID/latency, old shifted ID и new exact ID. Отсутствующий/failed/stale
отчёт не принимается. Проверка не является моделью всей электрической платы.

**P2, исправлено:** UGMEM скрывал PSRAM (11h) и UNSUPPORTED_MEMORY (13h)
под одинаковым DSS code=4. Теперь выводит сохранённый wire status/source/length,
а 14-byte MEM_TEST result показывает также для UNSUPPORTED_MEMORY. Новых
обращений к карте для вывода нет. CLI/exit codes/QUIET сохраняются; actual EXE
проверяет обе ошибки, slots/IFF, один запрос и отсутствие transport reset.
В этой поставке EXE изменились, ZIP/IMG нужно обновить вместе с UF2.

REAL_PENDING и S7 IN_PROGRESS сохраняются до контрольного функционального прогона.

## 2026-10-19: ROUNDTRIP, время двух ядер и диагностика этапов

Фото 12-02-59 подтверждает FULL: tested=125829120, first_bad=FFFFFFFF,
elapsed_ms=42240, PASS; ROUNDTRIP GS_DATA — host TIMEOUT. Фото 12-07-23:
16 bytes GS_DATA/BULK PASS. Фото 12-09-06: GS_DATA 1024/1025 PASS,
BULK 65536 — card HANDLE (07h). Session во всех трёх `FE7394808280CC68`.
Идентичность установленного UF2 известна со слов владельца; hash на экране
не выводится. Приёмка ROUNDTRIP/SAVE/аудио остаётся открытой.

**P1, исправлено:** `ug_minimal_dispatch` берёт `now` на core1, а core0
позже обновляет `transfer.last` при ACK/данных. Прежнее unsigned `now-last`
переполнялось и снимало grant как после 5 секунд простоя. Это согласуется
с наблюдениями: после утраты GS grant следующий входной байт остаётся
в DB; BULK END получает HANDLE. Новая проверка сначала acquire-читает phase,
затем last и принимает только истёкший интервал меньше половины timer range.
Чтение last до phase не допускается: иначе новый ACK мог бы публиковаться
между этими чтениями. Host timeout /SLOW не увеличен.

Регрессия исполняет production framing/latches/storage: 24 комбинации
GS_DATA/BULK, read/write, задержек 1/1000/10000 мкс и timer wrap. Более новые
ACK/данные сохраняют grant, 4999999 мкс простоя не отменяют, 5000000 отменяют
с освобождением pin. Скомпилированный вариант со старой арифметикой обязан
падать на этой проверке; его результат включён в HOST evidence.
Это доказательство ошибки порядка событий, не электрического ISA timing.

**P2, исправлено:** прежняя строка `END recovery` печаталась и при BEGIN,
grant или data timeout. Теперь до recovery выводятся сохранённый этап,
число байтов и смещение блока. Actual-EXE тесты инъецируют ошибки всех
восьми этапов, проверяют сохранение диагностики и отсутствие повторов.
Длина исходного ответа также сохраняется через CANCEL и INFO/OBJECT_INFO:
прежний `response_bytes=26h` на фото BULK относился к recovery OBJECT_INFO,
а не обязательно к отказавшему RPC. Отдельные actual-EXE ошибки HANDLE в
WRITE_END/READ_END проверяют нулевую исходную длину после cleanup.
CLI/protocol4/API1.0/Settings, Turbo 2→ISA→3 и exit codes сохранены.
