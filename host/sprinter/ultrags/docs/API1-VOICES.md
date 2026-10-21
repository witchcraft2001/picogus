MOD F00 extension (2026-10-21): PLAY_MOD opcode31/request3 bytes unchanged.
CAPS.features bit12=MOD_F00_POLICY; CAPS44/SNAPSHOT64 bytes unchanged.
Flags: bit0=LOOP, bit1=IGNORE_F00, bit2=PAUSE_F00; no policy bits follows live
GS6A. Both policy bits or unknown bits return BAD_ARGUMENT without replacement.
Explicit policy survives PAUSE/RESUME, SEEK, LOOP and later GS6A commands.
Historical GS PLAY/6A/66 retain their rules. UGPLAY/UGPF MOD file/HANDLE default
IGNORE, `/F00:IGNORE|PAUSE` selects explicitly; see [F00 notes](F00-README.md).

# ULTRAGS: API 1.0 VLS1, 32 голоса и GS

**2026-10-21: PROPLAY discovery/load/audio проверенного трека при Turbo OFF REAL_PASS.**
Исходный плеер нашёл GS в slot0 и показал Done. Владелец подтвердил
отключённый Turbo и последующее воспроизведение трека без искажений;
длительность прослушивания не указана. GS STATUS в Turbo ON
остаётся REAL_FAIL. UF2 R13 прежняя; S6/S7 IN_PROGRESS.
Evidence: `build/gs-clock-d4-real/real-0003.json`, `audio-confirmed.json`;
[подробности D4](GS-CLOCK-D4.md).
Далее — история предыдущих проверок.

**23:57: D4 REAL подтверждает отказ GS STATUS только в быстром столбце:**
все16 `SLOW1=7E FAST=FF SLOW2=7E`.
Следующий контроль исходного PROPLAY — с аппаратно запрещённым Turbo,
после UGGSC0 со всеми тремя столбцами 7E. UF2 R13 прежняя.
Это обходной путь; GS в Turbo ON остаётся REAL_FAIL. S6/S7 IN_PROGRESS.
Подробности: [D4](GS-CLOCK-D4.md).

**23:43: idle GS alias при Turbo OFF REAL_PASS, PROPLAY discovery REAL_FAIL.**
Следующая проверка — [D4](GS-CLOCK-D4.md): `UGGSC0` при текущем GSALIAS ON.
Сравнение OFF/ON/OFF только чтениями 00BB; без перепрошивки.
В `build/latest` добавлены два EXE D4; UF2 R13 и прежние EXE не изменены.
D4 HOST_PASS / REAL_PENDING; S6/S7 IN_PROGRESS. Далее — история.

**Текущий кандидат — [R13 GS STATUS FAST](GS-FAST-R13.md).**
D3 подтвердил native7E/aliasFF/native7E при Turbo OFF без перезапуска.
После прошивки R13 сначала MODE /GSALIAS ON → INFO → UGGS0;
только после ALIAS7E во всех строках — PROPLAY.
HOST_PASS / REAL_PENDING; основные EXE D2 и пробы D3 прежние.
Следующие записи о R12/D3 сохранены как история.

**22:48: GS discovery REAL_FAIL.** Алиасы включены, INFO PASS и ULTRAGS READY,
но PROPLAY сообщает General Sound not found. Следующая проверка —
[D3 UGGS0](GS-PROBE-D3.md), без перепрошивки. R12/D2 остаются текущими,
в комплект добавлены только read-only диагностические EXE.

**Текущая прошивка 2026-10-20 — R12 DIRECT CATALOGUE**, `build/latest/CURRENT.UF2`.
**Текущий host-комплект — D2.** PCM/FX на D1 прошли (22:09), MIX дал
host TIMEOUT SNAPSHOT. Исправлено округление срока ожидания DSS.
На D2 владелец подтвердил PASS всех трёх команд: UGMEM INFO →
UGTEST MIX /VOICES:32 /SECONDS:60 → UGMEM INFO.
Полный вывод и качество звука не подтверждены. Следующий этап —
[GSALIAS и PROPLAY](RPC-DEADLINE-D2.md#аппаратный-результат-d2), без перепрошивки.
Далее сохранена история предыдущего отказа LENGTH.
**История до D1: проверка была остановлена на PCM/FX:** MEMORY_OR_PROTOCOL code3,
rpc_source01/status03. Память QUICK и ROUNDTRIP 65537 /VERIFY прошли.
Сначала выполнить [диагностику UGTEST-D1](UGTEST-RPC-D1.md), заменив только EXE.
Серию MIX/GS до локализации ошибки не продолжать.
R11: REAL FAIL (21:01), GUS PASS и ULTRAGS CRC/HEADER FAIL.
[Проверка CONFIG R12](CONFIG-FAST-R12.md) в 21:28 прошла: MODE/INFO и повторные
INFO PASS. Память/обмен затем прошли, аудио дало отказ выше; общая приёмка
S6/S7 ещё не выполнена. LED/CONFIG_PROBE OFF.
Следующие записи о R9 и более ранних версиях сохранены как история.

**Актуально 2026-10-20 17:42:** R9 не прошла чтение каталога.
Текущая контрольная поставка — **R9-NOLED** в `build/latest`, с отключённой
LED-диагностикой. Сначала выполнить **CONFIG-COMPAT-R9-NOLED.md**;
полная проверка ниже отложена до восстановления CONFIG. REAL_PENDING.

**2026-10-20: R5 и R6 REAL FAIL, регрессия native.** После TIMEOUT
CONFIG и native/trace возвращают FF. R2–R4 также не прошли CONFIG на карте.
S6/S7 IN_PROGRESS; приёмка API/GS/audio не возобновлена.

Текущая выдача R9 COMPAT: **build/latest/CURRENT.ZIP**, прошивать **CURRENT.UF2**.
R8 восстановил native, но CONFIG-чтение не заработало; запись подтверждена UGW0.
В R9 возвращён прежний раздельный транспорт IOW10/IOR22 при текущем VLS1 API.
HOST PASS / REAL_PENDING; синий GPIO25 LED сохранён.
Сначала выполнить короткую проверку старта из **CONFIG-COMPAT-R9.md**.
История: CONFIG-REVIEW-R3/R4/R5/R6.md.

## Где брать комплект

Единственная точка выдачи: `build/` в корне репозитория PicoGUS;
`build/latest/` остаётся совместимой ссылкой на этот каталог.
`CURRENT.ZIP` содержит UG EXE, тестовые данные и инструкцию.
`CURRENT.UF2` и `CURRENT.IMG` выдаются отдельно и в ZIP не включаются.
CONFIG_TRACE/CONFIG_PROBE в R12 отключены, TRC0/1 и UGCL0/1 в комплект не входят.
Исторические `ug-full.zip`/PGMULTI.UF2
остались в прежних каталогах; прошивать их вместо CURRENT.UF2 не следует.
SHA-256 файлов архива записаны в `HASHES.TXT`, всех компонентов — в `DELIVERY.json`.
Внутренние каталоги сборки не являются комплектами для копирования.
Dirty build ID содержит git revision и сам по себе не различает все сборки
с незакоммиченными правками. Для точной идентификации используйте SHA-256 UF2
и полный каталог из `UGCFG INFO /DIAG`.

Для перехода на VLS1 нужны **новая прошивка и все UG*.EXE из одного комплекта**.
Старые экспериментальные UGM64/UGM256 не подходят к новой схеме ответов.
Common protocol остаётся 4; native API — исходная 1.0, без параллельной API2.
INFO имеет 40 байт и метку VLS1. Утилиты проверяют её до изменения объектов.
PGUSCFG, Settings, BIOS и ACEX не изменяются.

## Короткая проверка

Все команды ниже используют слот 0. Для слота 1 добавлять `/SLOT:1` к каждой UG-команде.
Сначала прошить карту обычным способом и скопировать новые EXE.

```text
UGCFG GUS
UGCFG INFO
UGCFG ULTRAGS /GSALIAS ON
UGCFG INFO /DIAG
UGCFG VERIFY
UGMEM INFO
UGMEM TEST QUICK
UGTEST PCM
UGTEST FX
UGTEST MIX /VOICES:32 /SECONDS:60
UGMEM INFO
```

Ожидаются PASS, `boot_state=0`, физическая память и свободный пул 8388608,
`objects=0` после UGTEST. MIX создаёт собственный тихий RAW-образец, занимает
32 моно-голоса, читает его с проверкой CRC во время воспроизведения и проверяет
счётчики protocol/underrun/PSRAM. Он очищает только свои экземпляры и объект.
Для MIX нужны свободные голоса; уже играющую музыку и FX сначала остановить.
ESC должен завершить команду с очисткой её временных ресурсов.

Затем провести тот же короткий прогон в другом ISA-слоте. Для основной памяти:

```text
UGMEM TEST FULL
UGMEM ROUNDTRIP 65537 /VERIFY
UGMEM ROUNDTRIP 65537 /SLOW /VERIFY
UGMEM INFO
```

Длинный `ROUNDTRIP 8388608 /VERIFY` оставить для отдельного прогона:
вывод WRITE/SEAL/READ показывает текущую фазу; время зависит от карты и DSS.
Программный стенд не задаёт ожидаемую аппаратную скорость.

## GS и неизменённый PROPLAY

```text
UGCFG ULTRAGS /GSALIAS ON
PROPLAY ATDT.MOD
```

PROPLAY запускать без изменений EXE, проверить отдельно с Turbo ON и OFF.
Ожидаются обнаружение GS в нужном слоте, завершение загрузки и нормальный звук.
Утилиты UG самостоятельно сохраняют переключение Turbo `2 → ISA → 3`.

Равнозначные команды для уже активного ULTRAGS:

```text
UGCFG /GSALIAS ON
UGCFG /GSALIAS OFF
UGCFG GSALIAS ON
```

GS использует ровно порты 00B3/00BB. Native BASE и BULK alias — отдельные настройки;
само изменение BASE не включает GS. GSALIAS действует до перезагрузки карты.
SAVE сохраняет startup mode и BASE/BULK alias; GSALIAS не входит в Settings.
`UGCFG ULTRAGS /GSALIAS ON /SAVE` включает GS сейчас и сохраняет режим ULTRAGS
для следующего старта; после отключения питания GSALIAS включить снова.

## Загрузка, выгрузка, музыка и FX

```text
UGLOAD ATDT.MOD /TYPE:MOD /VERIFY
UGDUMP M BACK.MOD /VERIFY
```

Вместо M подставить handle из вывода UGLOAD, не букву M. Сравнить BACK.MOD с
исходным файлом средствами DSS. UGDUMP печатает своё время и скорость.
При `/VERIFY` CRC файла складывается из уже проверенных на хосте блоков;
повторного прохода CRC по каждому буферу нет.

Для WAV:

```text
UGLOAD FX66_WAV.WAV /TYPE:WAV /VERIFY
UGPLAY HANDLE M /LOOP
UGPLAY FXHANDLE F /LOOP /GAIN:16
UGPLAY FXHANDLE F /LOOP /GAIN:16
UGMON /COUNT:2
UGPLAY FXSTOP ALL
UGPLAY STOP
UGMEM FREE F
UGMEM FREE M
UGMEM INFO
```

M и F — фактические разные handles MOD и WAV. Для MOD4 остаётся 28 физических
голосов: до 28 моно-FX либо 14 стерео-FX. Каждый запуск возвращает собственный
instance ID и число занятых голосов. При исчерпании пула ожидается NO_VOICE
без частичного запуска стерео. `/VOICE:N` задаёт первый предпочтительный
физический голос; чётность и соседство второго стерео-голоса не требуются.
При сложении громких сигналов возможен clipping; автоматического снижения gain нет.
Слушать звук и смотреть разницу счётчиков, а не только RESULT PASS.

## SAVE и завершение

После остановки воспроизведения и завершения всех передач:

```text
UGCFG VERIFY
UGCFG SAVE /DIAG
```

Ожидается `Save confirmed` и PASS. После полного выключения питания:

```text
UGCFG INFO /DIAG
UGMEM INFO
UGCFG GUS
UGCFG INFO
```

Ожидается самостоятельный старт ULTRAGS, пустая исправная память и успешный
возврат в GUS. Проверить также работу другой ISA-карты на том же логическом
слоте при её собственных непересекающихся адресах.

## Что требуется для аппаратной приёмки

Фото полного вывода с build ID, слотами и командами; результат прослушивания
MOD + нескольких FX; отсутствие новых underruns/PSRAM/protocol errors;
SAVE и старт после отключения питания. PIO и ARM проверяются по собранным
инструкциям, но это не измерение электрических задержек или SRAM-конкуренции.
32 голоса и бюджет полного аудиокванта окончательно подтверждаются на карте.

## Проводной контракт для клиентов

CAPS44 сообщает total/music/fx limits как u16 и общий пул; текущая прошивка —
32 голоса, RAW U8/S8/S16LE, PCM WAV и MOD4 M.K./M!K!. S3M/XM/IT, MOD8 и playlist
остаются отдельными работами. Параметр сборки UG_LANES не меняет формата API;
каждый профиль требует проверки SRAM, стека и времени рендера.

SNAPSHOT64 возвращает сводку и число зарезервированных физических голосов
(включая паузу), а не битовую маску. VOICE_STATUS/FX_STATUS читают страницы по
ключу session+snapshot_seq. Записи VOICEREC20 содержат физический u16 ID,
instance ID и логический канал; FXREC16 описывает экземпляр целиком.
Все страницы одного ключа удерживаются до нового latch/SNAPSHOT. При STATE
нужно получить новую сводку и начать обход страниц заново.
Полные размеры, offsets и семантика находятся в `ultra-gs-docs/ultra-gs.md`,
в решении владельца от 2026-10-19; equates генерируются из wire-schema.json.
