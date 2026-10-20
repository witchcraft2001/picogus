# R4: сокращение времени до захвата данных CONFIG

## Статус: R4 REAL FAIL, 2026-10-20 11:21

Фото11:21:41 повторяет TIMEOUT и все16 строк
`STATUS01 ERROR00 SEL00 RAWFF COUNTFF FLAGS0E`. Ускорение не устранило отказ.
Оно не подтверждено как исправление; дальнейшая приёмка отложена.
Следующая проверка — UGW0 на уже прошитой R4, без новой UF2, см.
`../../diagnostics/README.md`. RAWFF всё ещё неоднозначен: это и initial sentinel.

## Что показала карта

Фото 2026-10-20 10:49:13, CFGTRACE.UF2: переключение TIMEOUT, затем все16 строк
`STATUS=01 ERROR=00 SEL=00 RAW=FF COUNT=FF FLAGS=0E`.

FLAGS0E: последний CONFIG read ещё активен, адрес совпадает и capture разрешает
его обслуживание; CONFIG при этом **не разблокирован** (bit4=0). Native работает,
счётчик CONFIG reads насытился. Это сужает поиск до непринятой разблокировки/записи,
а не подтверждает прежнюю гипотезу об одном лишь позднем consuming read.
RAW=FF также является начальным значением: без отдельного счётчика writes он
не отличает отсутствующий write от реально захваченного FF. Поэтому поздний
захват данных — проверяемая гипотеза, не установленная электрическая причина.

## Изменение

R3 классифицировал порт перед ADS/data capture. Для native/GS до захвата
утверждается аппаратный WAIT; CONFIG полагается на поздний ARM handshake.
Классификатор откладывает переключение ADS, и короткое окно write-data может
закончиться до захвата. Рабочий GUS начинает ADS capture непосредственно после
DACK gate. Перенос latch перед классификатором отклонён: он отложил бы ранний
WAIT для native/GS.

В R4 ускорена классификация, прежнее раннее распознавание не перемещено:

- Оба ISA SM работают примерно вдвое быстрее GUS PIO. Делитель округляется
  вверх в реальных единицах16.8: при370MHz GUS=517/256, кандидат=259/256
  (~365.714MHz). Это не утверждение о частоте внешней ISA.
- ADS settling увеличен с8 до16 PIO clocks:43.75ns против GUS43.666ns при
  указанных делителях. Таким образом программный интервал не сокращён.
  Числа вычислены из конфигурации, не измерены на плате.
- Два начальных response OUT перенесены в `pio_sm_exec_wait_blocking`: сначала
  значение при удержанном WAIT и выключенных направлениях, затем FF directions
  с ADS=1 и WAIT=1. В PIO освобождены два слова для settling NOP.
- Автономный PIO tail по-прежнему отпускает WAIT, ждёт IOR high и снимает data
  directions без следующего ARM вызова. Независимый core1 fuse сохранён.
- Program32 words, точные BASE/ALIAS/B3/BB, DACK, foreign passivity и порядок
  предыдущего IOW перед read value сохранены. Другие режимы не получают новый PIO.

Protocol4/API1.0/Settings и основные UG EXE не менялись. В выдаваемом кандидате
оставлен диагностический UG_CONFIG_TRACE overlay+1C..1F, не часть API1.0.

## Проверки и границы

`config-write-window.py` задаёт конечное окно write-data, исполняет generated
R3 и новый PIO при согласованных абсолютных ADS setup, затем подаёт захваченные
байты в извлечённые production CONFIG C handlers с реальными ug_config/catalog.
3072 случая (три CONFIG порта,256 bytes, два окна, две фазы): R3 захватывает FF,
кандидат — исходные bytes.3060 различий (FF естественно совпадает). Последовательность
CC/01 из R3 отвергается actual C (control не разблокирован), из кандидата
разблокирует CONFIG и читает protocol4. Это модельное окно, а не измерение
Sprinter; его нельзя выдавать за доказательство причины конкретного REAL FAIL.
Native и GS в новом варианте получают WAIT раньше R3 при том же времени окна.

Generated PIO:512 maps,1048576 read/write адресов,524288 writes,288 INFO/CRC
streams,12 coupled IOW/IOR phases, full RX, DACK/ADS и256 mux patterns — PASS.
Production helper/fuse/map/forced OUT tests — PASS. Linked ARM capture/verdict
12 случаев проверяет обе forced OUT и автономный tail. Ten linked ARM audio
profiles — PASS. SRAM main свободно97092 bytes, Settings и шесть старых mode
images прежние, кроме объявленной SDK даты. Статический stack, PSRAM ID и SAVE
clock проверяются отдельно. Нет нового полного HOST/DSS прогона всего MVP;
EXE для TRC выполняются отдельно, основные9 EXE сохранены из frozen R3.

REAL-прогон11:21 дал FAIL (см. начало). ISA setup/hold/assertion/backpressure, скорость, слуховая
проверка и full GS acceptance не закрыты. S6/S7 IN_PROGRESS.

## Выдача

Постоянное место: `build/latest/CFGCAP.ZIP` и `CFGCAP.UF2`. Это R4 кандидат
с диагностикой; историческая `PGMULTI.UF2` в том же каталоге всё ещё R3 FAIL.
CFGCAP.ZIP включает нужный UF2, TRC0/1 и host IMG; IMG не содержит UF2.
TRACE.json и trace-evidence хранят соответствие байтов и проверки.

Прошить именно CFGCAP.UF2. В том же слоте0/base02A0 выполнить подряд:

```text
UGCFG ULTRAGS
TRC0
```

Сфотографировать оба результата, даже при PASS переключения. Не выполнять другие
UG команды между ними. Если переключение прошло:

```text
UGCFG INFO /DIAG
UGCFG VERIFY
UGMEM INFO
```

Для известного slot1 добавить /SLOT:1 и использовать TRC1. SAVE и дальнейшая
приёмка — после подтверждения исправного CONFIG. Новый повторный результат
FAIL будет свидетельством против выбранного изменения, не поводом объявлять
аппаратный PASS по модели.

## Зафиксированная выдача R4

Оба свежих MULTIFW build прошли проверку зависимостей; UF2 идентичны.
Все8 актуальных ISA reports проверены verifier, включая новый write-window.
Два независимых TRC EXE совпали;64 actual-EXE случая и ZIP/IMG byte identity PASS.
Опубликованы hashes payload/исходников и92 evidence files, проверены повторно.
Статический stack: parser с резервом 1408/2048, render 1336/2048 — PASS.
PSRAM ID и SAVE clock gates — PASS. Это targeted firmware/trace проверка,
не полный новый HOST/DSS прогон всех приложений и не REAL PASS.

CFGCAP.UF2:1709056 bytes, SHA256 `487cbe4461b5e0754273657fca79be3da5681bc039efa6df442b919473c43e8d`.
CFGCAP.ZIP:3188265 bytes, SHA256 `d6f6ac81693fc38462edd0701ba9a28f18580295aefc1288f43c2491d958a041`.
