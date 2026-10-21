# Диагностика старта ULTRAGS — 2026-10-20

**2026-10-21 00:03: PROPLAY с отключённым Turbo нашёл GS в slot0 и дошёл до Done.**
Владелец затем подтвердил воспроизведение трека без искажений:
обнаружение, загрузка и прослушивание этого трека при Turbo OFF REAL_PASS.
GS STATUS при Turbo ON остаётся REAL_FAIL по D4. Для исходного PROPLAY
рабочий режим на этом стенде — Turbo OFF / GSALIAS ON; новая UF2 не нужна.
Evidence: `build/gs-clock-d4-real/real-0003.json` и `audio-confirmed.json`.
Длительность прогона не указана. S6/S7 IN_PROGRESS.
Далее сохранена история диагностики.

**23:57: D4 воспроизвёл зависимость от Turbo:** все16 `7E / FF / 7E`.
Следующий контроль: штатно запретить Turbo, выполнить `UGGSC0`;
при всех трёх столбцах 7E — `PROPLAY C:\MEDIA\MODS\ATDT.MOD`.
Перепрошивка не нужна. Результат загрузки и звук проверяются отдельно.
Свидетельство: `build/gs-clock-d4-real/real-2357.json`.
Далее — история; D4 уже выполнен, его первоначальный REAL_PENDING устарел.

**Текущая проверка — [D4 GS clock](../ultrags/docs/GS-CLOCK-D4.md), без перепрошивки.**
23:43: UGGS0 даёт все 16 ALIAS7E при Turbo OFF, но PROPLAY всё ещё not found.
На текущем ULTRAGS / GSALIAS ON / slot0 запустить `UGGSC0` из CURRENT.ZIP.
Прислать все строки SLOW1/FAST/SLOW2; частота физически не измеряется.
UF2 R13 и все прежние EXE сохранены. D4 HOST_PASS / REAL_PENDING.
Далее — история предыдущих поставок.

**Текущая поставка — [R13 GS STATUS FAST](../ultrags/docs/GS-FAST-R13.md).**
D3 в 23:11 показывает 16 native7E/aliasFF/native7E при Turbo OFF; владелец
подтвердил отсутствие перезапуска. R13 переносит статистику после ответа
на 00BB, сохраняя live flags, точный decode и stale guard.
HOST_PASS / REAL_PENDING. После прошивки CURRENT.UF2:
UGCFG ULTRAGS /GSALIAS ON → UGCFG INFO → UGGS0.
При 16 строках ALIAS7E перейти к PROPLAY; при FF прислать вывод.
Основные EXE D2 и пробы D3 прежние. Далее сохранена история.

**Текущая проверка — [D3 GS probe](../ultrags/docs/GS-PROBE-D3.md).**
22:48: R12 READY, GSALIAS ON и INFO PASS, PROPLAY не обнаруживает GS.
В CURRENT.ZIP добавлены UGGS0/UGGS1; UF2 и девять основных D2 EXE прежние.
Без перепрошивки: на известном slot0 / BASE02A0 / GS ON выполнить UGGS0,
прислать весь вывод. Проба читает native/alias GS STATUS при Turbo OFF.
Причина физического отказа пока не установлена.

**Текущая проверка — [D2](../ultrags/docs/RPC-DEADLINE-D2.md).**
PCM/FX D1 PASS; MIX TIMEOUT. Исправлен воспроизведённый дефект округления
host-тайм-аута DSS. Обновляются UG*.EXE, прошивка R12 прежняя.
Владелец подтвердил PASS серии D2: UGMEM INFO →
UGTEST MIX /VOICES:32 /SECONDS:60 → UGMEM INFO.
Качество звука и значения objects отдельно не подтверждены.
Следующий этап — GSALIAS/PROPLAY по инструкции D2. Далее — история.

**Продолжение R12:** память QUICK и ROUNDTRIP 65537 /VERIFY PASS;
UGTEST PCM/FX FAIL source01/status03. Текущая процедура —
[UGTEST-D1](../ultrags/docs/UGTEST-RPC-D1.md). Заменить только UGTEST.EXE,
UF2 остаётся прежней. Причина host LENGTH ещё не установлена.

**Текущая прошивка — R12 DIRECT CATALOGUE, HOST_PASS / REAL_PASS серии CONFIG 21:28.**
`build/latest/CURRENT.UF2`; [команды и ограничения](../ultrags/docs/CONFIG-FAST-R12.md).
R11 в 21:01: GUS PASS, ULTRAGS FAIL; восемь замен 0→1 точно воспроизводят CRC.
R12: MODE/INFO в GUS и ULTRAGS PASS на фото; повторные INFO PASS по сообщению
владельца. Проверка выполнена с aliases OFF; нагрузка и GS ещё не приняты.
Доказательство: `build/config-fast12-real/r12-real-2128.json`.
UGCL0/UGCL1 на R12 не применять — проба отключена.
Далее сохранены исторические результаты и процедуры.

**Предыдущая поставка — R11 CONFIG PROBE; HOST PASS, REAL FAIL 20:38.**
CATALOG_HEADER expected43/receivedFF; `LATE00 INDEXFF SENTFF FLAGSA4`.
Это не подтверждает отказ WAIT: проба не охватывает ранние stale-reject
и не сообщает число учтённых байтов. INDEX/SENT здесь пустые.
Первый замер уже сохранён; перепрошивать R11 ещё раз не требуется.
`build/config-probe11-delivery/CURRENT.UF2`; [инструкции и ограничения](../ultrags/docs/CONFIG-PROBE-R11.md).
R10 дала CATALOG_CRC FAIL (19:33); замена байта 101 C8→FF воспроизводит CRC.
В R11 измеряется `/IOR` непосредственно перед отправкой CONFIG-байта.
Новая утилита `UGCL0`/`UGCL1` читает только шесть native-регистров.
Сразу после `UGCFG ULTRAGS`, даже при FAIL, выполнить UGCL своего слота.
**Не выполнять INFO между ними:** выбор каталога сбрасывает измерение.
Аппаратный отказ ещё не закрыт; дальнейшие инструкции R10/R9/R8 — история.

Ревью предложений: [CONFIG-REVIEW-R11.md](../ultrags/docs/CONFIG-REVIEW-R11.md).
Стенд уточнён: стоковый Sprinter DX без доработок. UF2 R11 не заменялась.
`LATE=0` при FAIL не доказывает, что хост не принял WAIT.

**18:05, R9-NOLED REAL FAIL после READY:** PASS/PASS/FAIL/PASS/PASS,
UGMEM INFO PASS (8 МиБ, objects0). Отказ не ограничен стартом.
Две видимые замены D3→FF и 00→01 воспроизводят CRC повреждённого каталога.
Повторять прежнюю серию INFO не требуется.
Текущий [отчёт](../ultrags/docs/CONFIG-COMPAT-R9-NOLED.md).

**18:01:32, R9-NOLED:** MODE — CATALOG_CRC FAIL, последующий INFO — PASS
с READY и верным CRC. Отказ не устранён полностью. Следующая проверка —
пять INFO /DIAG подряд и UGMEM INFO без смены режима/перепрошивки.
Текущий [отчёт](../ultrags/docs/CONFIG-COMPAT-R9-NOLED.md).

**R9 REAL FAIL 17:40/17:42:** режим ULTRAGS работает, поток каталога
повреждается FF. Следующая поставка — **R9-NOLED**, контроль без LED IRQ
на core0. [Инструкция](../ultrags/docs/CONFIG-COMPAT-R9-NOLED.md).
Диагностических групп вспышек в ней нет. Ниже история предыдущих поставок.

**Текущая поставка — R9 COMPAT, HOST PASS / REAL_PENDING.**
`build/latest/CURRENT.UF2`, инструкции:
[CONFIG-COMPAT-R9.md](../ultrags/docs/CONFIG-COMPAT-R9.md).
UGW0 на R8 в 16:42:22 подтвердил native/CONFIG-записи при отказе CONFIG-чтения.
В R9 возвращены отдельные IOW10/IOR22; CONFIG_TRACE выключен.
TRC0/1 и trace-поля UGW на R9 не применять.

### Историческая проверка R8

Текущий результат — **R8 REAL FAIL**, фото 16:24:44: native STATUS01/ERROR00
восстановлены, CONFIG всё ещё TIMEOUT. Следующая проверка — **UGW0 без
перепрошивки**, [CONFIG-R8-FOLLOWUP.md](../ultrags/docs/CONFIG-R8-FOLLOWUP.md).
UGW0/UGW1 и WRPROBE.ZIP доступны в `build/latest`; CURRENT.UF2 сохранён побайтно.

Предыдущая выдача — **R8 ISA tag**, `build/latest/CURRENT.UF2` и `CURRENT.ZIP`.
Исправлены зависимость метки цикла от входного GPIO26 и ложный прогресс
guard при отбрасывании чужих циклов. HOST PASS / REAL_PENDING.
Команды и отчёт: [CONFIG-TAG-R8.md](../ultrags/docs/CONFIG-TAG-R8.md).
Две сборки совпали; шесть других режимов побайтно идентичны R7.
R8.json содержит hashes payload и 139 файлов evidence.

### Предшествующий результат R7

Индикация предназначена для E1MAGIC Rev 1.5 / синего GPIO25 LED.
Прямое USB-соединение работающего Sprinter с Mac не требуется.
Команды, коды 1–9 и ограничения:
[CONFIG-LED-R7.md](../ultrags/docs/CONFIG-LED-R7.md).
R6 имеет REAL FAIL. На R7 владелец сообщил TIMEOUT / RESULT FAIL и код LED 4
(четыре вспышки каждые 3–4 секунды): CONFIG-чтения зарегистрированы,
но правильный ответ/READY не подтверждён. Фото TRC0 15:28:26: все 16 строк
STATUS/ERROR/SEL/RAW/COUNT/FLAGS=FF. Позже владелец сообщил код LED 5:
guard зафиксировал WAIT без завершений и отключил ISA. Код 5 замечен через
примерно 1–2 минуты, после переноса фото на Mac; сам переход не наблюдался.
Время срабатывания относительно TRC0 и причина первоначального отказа
не установлены.

## История предыдущих выдач

Упоминания `build/latest` ниже относятся к моменту соответствующей выдачи,
а не к текущему содержимому. Старые выдачи сохранены в своих каталогах.

R2 не прошёл функциональную проверку на карте: после холодного включения GUS
отвечает, переключение `UGCFG ULTRAGS` как с `/GSALIAS ON`, так и без него
завершается TIMEOUT; последующий `UGCFG INFO /DIAG` читает selector/magic/
protocol как FF. Фото владельца: 08:54:06/10 и 08:57:40/44. Алиас применяется
клиентом после Startup verified, до него выполнение не дошло.

Фото09:17:38: все16 строк UGP0 `CFG_1D0=FF STATUS_2A1=01 ERROR_2A6=00`.
Native отвечает; отказ локализован в конфигурационном обмене. Исправление и
новые регрессии — `../ultrags/docs/CONFIG-REVIEW-R3.md`; REAL-прогон R3 10:13:07/10 также FAIL, с тем же UGP0 результатом.

Исходное предположение до probe: FF на конфигурационных портах не доказывает
остановку процессора: возможен отказ самого конфигурационного обмена.
В shared32 PIO конфигурация остаётся на позднем ARM handshake, в отличие
от native и GS. Возможность пропуска конфигурационного цикла проверяется;
это гипотеза, а не подтверждённое объяснение аппаратного результата.

## Сбор данных без перепрошивки

В постоянном `build/latest/` добавлены отдельные `UGP0.EXE`, `UGP1.EXE`,
`BOOTPROB.ZIP` и `BOOTPROB.IMG`. При первой выдаче probe исходная R2 была сохранена без изменения байтов.
После исправления в build/latest опубликована R3 вместе с теми же probe;
её описание и команды — в CONFIG-REVIEW-R3.md. Диагностическое дополнение
не меняет UF2/EXE/ZIP/IMG того production-комплекта, к которому добавлено.
Проверки прежней поставки повторены; это не новое подтверждение её работы
на карте. Источник и доказательства probe — `PROBE.json`/`probe-evidence/`.

Скопировать UGP0.EXE на Sprinter. Сразу после неудачного переключения в ULTRAGS,
не выключая питание и не выполняя другие UG-команды, запустить:

```text
UGP0
```

Только для известной карты в слоте0 и native BASE=02A0. Для известной карты
в слоте1 использовать UGP1. Это диагностическое исключение из discovery-first
правила обычных клиентов: сломанная discovery как раз исследуется.

Собираются16 строк: CFG selector1D0, native STATUS2A1 и ERROR2A6. Записей в
порты карты, consuming DATA/RESPONSE reads, SAVE и reset нет. Каждый read
имеет собственное ISA window; PAGE3/IFF и Turbo2→ISA→3 проверены исполнением.
`DIAGNOSTIC COMPLETE` означает лишь завершение сбора, не PASS карты.

Ответ native при FF конфигурации доказывает, что процессор обслуживает native
интерфейс. FF обоих интерфейсов не различает остановку, отключение интерфейса
предохранителем и другие отказы шины. Нужен полный вывод с карты; повторная
прошивка для этого probe не требуется.

Две независимые сборки,80 actual-EXE сценариев (оба слота, IFF/Turbo, пять
состояний ответов), byte identity EXE из ZIP/IMG — PASS. Эти модели не задают
реальные ISA задержки. REAL_PENDING, S6/S7 IN_PROGRESS сохранены.

## CONFIG TRACE после повторного отказа R3

Сборка `CFGTRACE.UF2` — отдельная диагностика, не исправленная production.
Источник — `UG_CONFIG_TRACE` в picogus.cpp/CMake; по умолчанию выключен.
PIO не меняется. Временный overlay native+1C..1F отсутствует в API1.0 и
обычной PGMULTI.UF2. Добавленные инструкции могут повлиять на время обслуживания.

В `build/latest/`: `CFGTRACE.UF2`, `TRC0.EXE`, `TRC1.EXE`, `CFGTRACE.ZIP`,
`CFGTRACE.IMG`, `TRACE.TXT`, `TRACE.json`, `STATUS.TXT`. ZIP включает UF2,
EXE и host IMG. IMG содержит только host-часть, UF2 не помещается в1.44MB.
Старые production-файлы сохранены побайтно и отмечены как историческая R3 FAIL.

1. Через USB BOOTSEL записать **CFGTRACE.UF2**.
2. После запуска, та же карта slot0/base02A0: `UGCFG ULTRAGS`.
3. Сразу `TRC0`, без других UG-команд между ними. Сфотографировать весь вывод.
   Даже если переключение прошло успешно, собрать TRC0. SAVE не выполнять.
   Для известного слота1: `UGCFG ULTRAGS /SLOT:1`, затем `TRC1`.

Вывод:

- STATUS/ERROR: обычные native-регистры.
- SEL: фактически принятый селектор.
- RAW: последний захваченный write1D0; FF до первого write.
- COUNT: число захваченных CONFIG reads, насыщается FF.
- FLAGS: bit0=PІO ownership; bit1=IOR low после capture; bit2=live address
  совпал; bit3=eligible service; bit4=config unlocked; bit5=fuse failed;
  bits6..7=порт минус1D0.

TRC не пишет порты карты и не читает CONFIG/DATA/RESPONSE. Состояние trace
не сбрасывает. Каждое чтение — отдельное ISA window с прежним Turbo2→ISA→3.
Это исключение discovery-first только для известной карты с отказавшим CONFIG.
После диагностики обычный образ — PGMULTI.UF2, но R3 не считается исправленной.

Production-C fixture исполняет исходные write/capture/read ветви с trace:
принятый/raw selector, eligible/expired flags, отсутствие consuming side effects,
насыщение счётчика. Два firmware build и два ассемблирования EXE должны совпасть;
64 actual-EXE сценария проверяют read-only/context/slot/IFF/Turbo и ZIP/IMG bytes.
Доказательства сохраняются отдельно в TRACE.json/trace-evidence. Это HOST_PASS,
аппаратная причина ещё неизвестна. S6/S7 IN_PROGRESS.

Подтверждено при выдаче: два свежих MULTIFW build прошли проверку зависимостей,
UF2 побайтно совпадают; generated PIO идентичен R3. Два независимых EXE
ассемблирования совпали; все64 actual-EXE проверки и ZIP/IMG extraction PASS.
Production-C fixture запущен с --trace, прошёл проверки trace и регрессии
213 bus operations; trace-переменные подтверждены в исполненном бинарнике.
Проверены исходные hashes и файлы опубликованного TRACE.json; diff --check PASS.
Это не подтверждает устранение отказа на карте.

CFGTRACE.UF2:1708544 bytes,
SHA256 f431c06200e13c62ae938ea3e71055964f96d6e64ab023896f7060b644171adc.
TRC0.EXE:1244 bytes,
SHA256 8d01f44e0da2df79a688a76cf148ab225c7ccf2e3a2e6844669aa1b214b04b7a.
CFGTRACE.ZIP:
SHA256 71a352ae32d11c3466ddb7ae357fe3032fd58b75636d769c19254977ad7395a3.

## Результат TRACE 10:49 и следующий кандидат

Получено STATUS01 ERROR00 SEL00 RAWFF COUNTFF FLAGS0E. CONFIG read eligible,
но control заблокирован. RAWFF также начальное значение: факт записи FF
отдельно не доказан. Подготовлен R4 с более ранним data capture за счёт
ускоренного классификатора и сохранённого ADS setup; подробности
`../ultrags/docs/CONFIG-REVIEW-R4.md`.

Текущая выдача для проверки: `build/latest/CFGCAP.ZIP`, прошить CFGCAP.UF2.
Затем подряд `UGCFG ULTRAGS`, `TRC0`. Сфотографировать результат; при PASS
дополнительно `UGCFG INFO /DIAG`, `UGCFG VERIFY`, `UGMEM INFO`.
Это кандидат с trace, аппаратного PASS пока нет. PGMULTI.UF2 — историческая R3.

## REAL R4 FAIL 11:21:41 — проверка IOW без новой прошивки

Получен тот же TIMEOUT/SEL00/RAWFF/FLAGS0E. Изменение clocks не устранило отказ.
RAWFF не доказывает принятый FF: это ещё и начальное значение trace. До нового
изменения firmware требуется отличить отказ всего IOW от отказа только CONFIG.

В постоянном `build/latest/`: `UGW0.EXE`, `UGW1.EXE`, `WRPROBE.ZIP`,
`WRPROBE.IMG`, `WPROBE.TXT`, `WRITE-PROBE.json`, `write-evidence/`.
**Новая прошивка не нужна**, используется установленная R4 CFGCAP.UF2.

После неудачного UGCFG ULTRAGS, в том же slot0/base02A0 запустить:

```text
UGW0
```

Для известного slot1 — UGW1. Это диагностическое исключение discovery-first
только для уже известной карты. Начальные STATUS01/ERROR00 обязательны; иначе
утилита заканчивает работу без записи в карту.

Операции по порядку:

1. Чтение native STATUS2A1/ERROR2A6.
2. Write FF в native CONTROL2A2. В production C это намеренная неизвестная
   команда: expected STATUS21/ERROR02. Объекты и transport state не меняются.
3. Write A2 в CONTROL2A2: очистка ERROR, expected STATUS01/ERROR00.
4. Стандартные unlockCC и selector01 в CONFIG1D0 (по отдельному ISA window),
   чтение echo1D0/protocol1D2. Expected01/04.
5. Native trace SEL/RAW/FLAGS, без consuming DATA/RESPONSE reads.

Нет mode/SAVE/reset/object операций. CONFIG selector/protocol — не consuming
native DATA/RESPONSE. Для каждой операции прежние Turbo2→ISA→3/PAGE3/IFF.
После записи FF код02 ожидается специально; затем должен быть очищен A2.
COMPLETE означает завершение диагностики, не приёмку платы.

Если native ERROR меняется02→00, путь записи до native работает; если CONFIG
после отдельных access windows оживает, это отличает его от обмена UGCFG.
Если native ERROR остаётся00 и CONFIG не меняется, нужно исследовать общий
IOW capture/DACK/SM0. Эти варианты нельзя различить прежним read-only TRC0.

Два независимых assembly build,96 actual-EXE случаев: slots0/1, IFF/Turbo,
оба write path/по отдельности/оба отключены, busy/preexisting-error abort.
Проверены ровно четыре разрешённые записи, чтения и итоговое ERROR00,
сохранение контекста, ZIP/IMG byte identity. Ожидаемая ERROR02→00 и unlock/
protocol4 последовательность дополнительно выполнена actual production C
через неизменённые ветви picogus.cpp/ug_minimal.c/ug_config.c. Всё PASS.
Это проверка инструмента и ожидаемого поведения, не доказательство REAL IOW.

STATUS.TXT помечает R4 REAL FAIL. Сохранённые PGMULTI/CFGCAP — исторические
прошивки с известным аппаратным отказом, не новые исправленные версии.
S6/S7 IN_PROGRESS. Для следующего шага нужен полный вывод UGW0, без перепрошивки.

UGW0 при принятой команде FF также увеличивает protocol_errors на1.
A2 очищает ERROR, но не счётчик статистики; это ожидаемый след диагностики,
его нельзя считать новой спонтанной ошибкой при последующем UGMON.

## Probe11:44 и кандидат R5

UGW0: native error02→00; CONFIG принимает01 (TRACE_SEL01 RAW01 FLAGS9E), но
read даёт SELFF PROTOFF. Native и CONFIG writes в этой пробе работают; отказ
CONFIG read подтверждён. До UGW0 RAWFF был неоднозначным initial sentinel.

R5 устраняет write-data/ADS ожидание в IOR, сохраняет IOW и добавляет recheck
consuming read после предыдущего IOW. Details/ограничения/команды:
`../ultrags/docs/CONFIG-REVIEW-R5.md`. Новый аппаратный результат ожидается.
Текущий кандидат теперь по постоянным именам `build/latest/CURRENT.ZIP` и
`CURRENT.UF2`. Прошить CURRENT.UF2, затем UGCFG ULTRAGS и TRC0 подряд.
При PASS — UGCFG INFO /DIAG, UGCFG VERIFY, UGMEM INFO. S6/S7 IN_PROGRESS.


## REAL R5 FAIL12:42 — кандидат R6

После TIMEOUT все16 строк TRC0: STATUS/ERROR/SEL/RAW/COUNT/FLAGS=FF.
Это регрессия native относительно R4; по FF нельзя доказать guard или boot failure.
R5 отклонена. R6 добавляет WAIT1 перед WAIT0 в PIO rearm и дополнительный
clock для ownership feedback; IOW ADS settling16 clocks сохранено.
Программная модель воспроизводит hazard R5, но это ещё не причина REAL allFF.
Текущие постоянные имена: build/latest/CURRENT.ZIP, CURRENT.UF2.
После прошивки R6 выполнить UGCFG ULTRAGS, затем TRC0 без других UG-команд.
При PASS: UGCFG INFO /DIAG, UGCFG VERIFY, UGMEM INFO. SAVE пока не нужен.
Подробности: ../ultrags/docs/CONFIG-REVIEW-R6.md.
**Текущая выдача R6: build/latest/CURRENT.ZIP, файл CURRENT.UF2.**
R5 REAL FAIL12:42; аппаратный результат R6 ожидается. Команды: UGCFG ULTRAGS, TRC0.
Разделы R3–R5 ниже — история диагностики; актуальные notes — CONFIG-REVIEW-R6.md.

