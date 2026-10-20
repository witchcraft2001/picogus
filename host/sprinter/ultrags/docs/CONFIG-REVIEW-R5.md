# R5: ранний захват адреса CONFIG при чтении

## REAL FAIL 2026-10-20 12:42:22

R5 регрессировала: после TIMEOUT все16 строк TRC0 содержат
STATUS/ERROR/SEL/RAW/COUNT/FLAGS=FF. В отличие от R4 native тоже не отвечает.
Снимок не различает остановку PIO, незапуск и срабатывание guard.
Программные PASS ниже не являются подтверждением исправления. R5 отклонена.

## Предыдущий REAL 2026-10-20 11:44:27

На R4 UGW0 получил:

```text
BEFORE:    STATUS=01 ERROR=00
NATIVE FF: STATUS=21 ERROR=02
NATIVE A2: STATUS=01 ERROR=00
CONFIG: SEL=FF PROTO=FF TRACE_SEL=01 RAW=01 FLAGS=9E
```

Native-записи приняты и ожидаемая ошибка очищена. CONFIG unlockCC/select01,
сделанные пробой через отдельные ISA windows, тоже приняты: selector01/raw01,
control_active=1. Однако чтение CONFIG не доставляет ожидаемые01/04 хосту.
FLAGS9E: последний порт1D2, IOR ещё низкий/адрес совпадает/service eligible,
software wait, CONFIG unlocked. Это исключает общий отказ IOW в этой пробе.
Результат не доказывает корректность каждого back-to-back write внутри UGCFG.
Предположение о потерянном data byte как единственной причине не подтверждено.

Низкий IOR при ARM capture не доказывает принятие IOCHRDY хостом: момент его
проверки может предшествовать моменту выборки данных. Прежняя модель связывала
эти события. Ошибка модели исправлена; физические моменты на стенде не измерены.

## Изменение R5

R4 выполняла общий address+write-data capture для обоих направлений. Чтение
CONFIG без раннего PIO ownership ждало ADS и16 settling clocks, второй RX word,
и только затем ARM пытался включить WAIT. Это лишняя задержка для чтения.

- IOR теперь публикует один полный снимок адреса с ownership tag и аппаратным
  wrap сразу переходит в parked. ADS до выдачи ответа не переключается.
- IOW сохраняет два снимка, DACK gate, раннее точное BASE/ALIAS/B3/BB,16-clock
  setup и R4 clocks. Путь записи в этой итерации не переконструирован.
- Ответный tail перемещён перед restart, поэтому после IOR high направления
  снимаются автономно и программа попадает в wait следующего чтения. Wrap для
  чтения имеет target=parked, top=address_only; это допустимые адреса PIO.
- Production C-SDK init из generated header исполняется в отдельном C fixture:
  проверены оба wrap, initial PCs, pins, shift/autopush и divider. Модель не
  подставляет собственный wrap без проверки фактической инициализации.
- Software wait больше не превращается в immutable hardware ownership. После
  предыдущего IOW CONFIG recheck проверяет активность перед consuming handler.
  Поздняя выдача также проверяет живые IOR/address. Ended-cycle read не должен
  сдвигать каталог или заново включать data drivers.

Program32 words, main SRAM free96996 bytes. Protocol4/API1.0/Settings и основные
UG EXE не менялись. Другие шесть mode images прежние, кроме SDK date. Независимый
core1 fuse и прежний Turbo2→ISA→3 сохранены. В кандидате включён тот же временный
trace overlay, который не является частью API1.0.

## Проверки

- Generated PIO:512 maps,1048576 read/write адресов,524288 writes,288 INFO/CRC
  streams,12 coupled IOW/IOR phases, DACK/ADS/fullRX и mux256 — PASS.
- Production C helper/fuse/map/late-TX + generated C-SDK SM init — PASS.
- Config exchange213 trace operations и мутации: expired at capture и expired
  после предыдущего IOW, no stale consume; native ownership/order — PASS.
- Linked ARM capture/verdict12 случаев — PASS.
- Новая linked ARM + PIO проверка:9 случаев с раздельными WAIT latch/data sample
  и3 forced-ended-cycle cases. R4 baseline — реальный ELF+PIO, matched frozen
  reference. При сконструированном latch между моментами acquisition R4
  утверждает WAIT ещё при низком IOR, но хост уже не принимает его и видит FF;
  R5 получает wait раньше и доставляет байт.3 ended cases не потребляют данные
  и не включают новые data drivers после IOR high.
- Эти instruction ticks и8-tick peer latency — заданная модель. Latch выбран
  между наблюдёнными acquisition instants, не измерен на Sprinter. Это тест
  устранения лишней задержки/защиты, а не доказательство электрической причины.
- Регрессия записи3072 cases generated PIO→production CONFIG C — PASS.
-10 linked ARM audio profiles, SRAM/Settings/шесть старых modes, static stack,
  SAVE clock и PSRAM ID — PASS.
- Два свежих MULTIFW build должны совпасть;9 ISA reports проходят freshness
  verifier. TRC0/1 отдельно проверяются в64 actual-EXE случаях и ZIP/IMG.

Полный новый HOST/DSS прогон всех приложений не заявляется; прежние9 основных
EXE сохранены побайтно. Новый аппаратный результат ещё нужен. S6/S7 IN_PROGRESS.

## Выдача и тест

Постоянные имена текущего кандидата: `build/latest/CURRENT.ZIP`, `CURRENT.UF2`.
Архив содержит UF2, TRC0/1 и host IMG. Исторический PGMULTI.UF2 — R3 REAL FAIL.
Текущая версия/ограничения — STATUS.TXT, TRACE.TXT, TRACE.json/trace-evidence.

Прошить CURRENT.UF2 из нового CURRENT.ZIP, затем в том же slot0/base02A0:

```text
UGCFG ULTRAGS
TRC0
```

Сфотографировать оба результата. Не выполнять другие UG-команды между ними.
При PASS переключения:

```text
UGCFG INFO /DIAG
UGCFG VERIFY
UGMEM INFO
```

Для slot1 добавить /SLOT:1 и использовать TRC1. GSALIAS/SAVE и дальнейшую
приёмку продолжать после подтверждения CONFIG. Программные проверки не
заменяют REAL timing/backpressure/tri-state и аудио gates.

## Зафиксированная выдача R5

Два свежих MULTIFW UF2 побайтно совпали; все9 ISA reports актуальны и прошли
verifier.64 actual-EXE сценария TRC0/1 в двух независимых сборках, ZIP/IMG
byte identity, исходники/payload/98 evidence hashes проверены после публикации.

CURRENT.UF2:1709056 bytes, SHA256 `98ae20d12bcda663eaa6f3f8f953ceb75cccea27662cd3652a417933e3b928dd`.
CURRENT.ZIP:3188379 bytes, SHA256 `72ebc78d57fb37533e0dbfe89524941e6be07cea9bd4ef50b49a15124bf670d6`.

Историческая выдача: targeted firmware/trace PASS, но REAL R5 FAIL12:42;
S6/S7 остаются IN_PROGRESS.
