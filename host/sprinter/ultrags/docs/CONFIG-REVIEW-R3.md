# R3: конфигурационный обмен после переключения в ULTRAGS

## Статус после аппаратной проверки: R3 FAIL

Фото 2026-10-20 10:13:07/10: R3 вновь TIMEOUT/SELECTOR; все16 UGP0 строк
`CFG_1D0=FF STATUS_2A1=01 ERROR_2A6=00`. Изменения ниже не устранили отказ.
Capture/verdict тест не покрывает время до capture и не доказывает первый WAIT
на стенде. Причина пока не установлена. Следующий шаг — отдельная CFGTRACE
диагностика, см. `../../diagnostics/README.md`. Приёмочные тесты отложены.

## REAL отказ и локализация

На штатном стенде владельца R2: GUS отвечает; GUS→ULTRAGS завершается TIMEOUT
с `/GSALIAS ON` и без него. Затем config selector/magic/protocol=FF.
Фото 2026-10-20 09:17:38: read-only UGP0, slot0/base02A0, все16 строк
`CFG_1D0=FF STATUS_2A1=01 ERROR_2A6=00`.

Native интерфейс обслуживается ARM: это не доказанный отказ запуска процессора
или PSRAM. GSALIAS ещё не включался: клиент применяет его после Startup verified.
Аппаратный результат R2 — FAIL конфигурационного обмена. Вариант отказа при позднем
CONFIG дополнительно воспроизведён программно; устранение на карте
должно быть подтверждено отдельным прогоном R3.

## Исправление

- Core0 предварительно захватывает IOR и растягивает живой CONFIG read до
  работы с предыдущим IOW. Сам IOW применяется до вычисления read value:
  selector/data/map ordering сохраняется.
- Непотреблённый запрос, текущий адрес и активный IOR проверяются до WAIT.
  Чужой или завершившийся цикл не получает wait/data drive. Просроченный
  CONFIG read не вызывает consuming FWSTRING/catalogue handler.
- Смена BASE/ALIAS/GS допускает parked IOR с неизменяемым captured ownership,
  включая уже prefetched CONFIG. FIFO не отбрасывается. Классификатору дают
  ограниченное число шагов дойти до idle/parked перед patch; затем ACK IOW.
- После срабатывания fuse новый read не обслуживается и не потребляет байт.

- Исправлено отдельное расхождение с GUS: R2 ждал лишь4 PIO clock после ADS,
  GUS —8 при divider clk_sys/183MHz (~2.02 при370MHz), а не clk_sys/1.
  R3 использует те же8 clocks и тот же IOW divider. Ранее опубликованное
  сравнение «4/2 равны8/370MHz» было ошибочным. Реальная требуемая задержка
  мультиплексора на стенде отдельно не измерялась; восстановлен рабочий эталон.

PIO остаётся32 слова: исходный снимок адреса сохраняется в OSR, его остаток
переиспользуется для точного GS decode; освободившееся слово добавляет время
ADS settling. Раннее распознавание BASE/ALIAS и точных B3/BB, DACK и
автономное освобождение data pins сохраняются.
CONFIG всё ещё требует своевременного ARM capture; это не независимый PIO
classifier конфигурационных портов и не обещание выдержать неограниченную
остановку ARM до захвата CONFIG.

Protocol4, native API1.0 VLS1, Settings, PGUSCFG, BIOS/ACEX не менялись.
Assembler inputs основных EXE не менялись; повторно проверяется их идентичность
исполненным байтам обоих комплектов.

## Проверки

Новая проверка `config-read-arm.py`: исполнение linked Cortex-M0 capture/verdict
и generated PIO. Объявленный baseline — ELF опубликованного R2. Для трёх CONFIG
портов и трёх задержек после capture R2 возвращает FF, R3 удерживает цикл и
возвращает ожидаемый байт. Ещё три проверки подтверждают false eligibility
после завершения цикла. Решение вызвать consuming handler моделируется по
этому bool; его фактическое применение проверяется production-C fixture.

`config-exchange.py` извлекает настоящие prepare/IOW/IOR/poll тела из picogus.cpp.
Добавлены stale catalogue index и CONFIG prefetch→предыдущая смена selector→
reply. Мутации позднего prefetch и потребления stale read отвергаются вместе
с прежними native INFO/CRC/IOW ordering мутациями. `handshake-guard-check.py`
проверяет exact CONFIG membership по1024 адресам, истёкшие/чужие циклы,
parked/in-progress map publication и отказ обслуживания после fuse.

Instruction ticks этих моделей не являются физическими циклами RP2040,
полным polling timing bound, измерением SRAM arbitration или ISA setup/hold.
Первый захват CONFIG всё ещё должен уложиться в реальный host deadline.

Generated-инструкциям добавлена конечная модель mux propagation8 clocks:
256 значений данных, GUS и R3 читают точно; R2 искажает255 значений (FF
естественно совпадает). Проверяется источник общего IOW divider и интервалы
из исполненных инструкций. Это отрицательный контроль прежнего недостаточного
settling, не измерение конкретного трансивера.

## Передача на карту

Постоянный путь — `build/latest/`. Для первого прогона достаточно новой UF2;
основные EXE R2 совместимы. Последовательность после обычной прошивки:

```text
UGCFG GUS
UGCFG ULTRAGS
UGCFG INFO /DIAG
UGCFG VERIFY
UGMEM INFO
UGCFG /GSALIAS ON
UGCFG INFO /DIAG
```

Если переключение снова TIMEOUT, сразу UGP0 и полный вывод. SAVE пока отложить
до PASS этих проверок. S6/S7 IN_PROGRESS, REAL_PENDING сохраняются.

## Результаты и идентичность поставки

Оба комплекта:1918 PASS/0 FAIL,43 EXE;198 EXE/production-C scenarios,
82 MOD4 EXE/66 C-model,238 context,47 Turbo,3 malformed-page checks — PASS.
Повторены C/UBSan/shared32/64/render1890, linked ARM10 profiles+12 CONFIG,
generated PIO all-map/address/mux256, guard/fuse, PSRAM ID/SAVE clock,
SRAM/Settings/stack. Main SRAM free97368, static render1336/parser1408 из2048.
Другие шесть modes byte-identical кроме объявленной SDK даты; mutations rejected.

Все9 основных EXE byte-identical R2 и исполненным/извлечённым ZIP/IMG.
Два полных набора идентичны;17 файлов+56 evidence,73 подмены отвергнуты.
Основные EXE R2 подходят; заменить UF2. Постоянный путь build/latest/.

- PGMULTI.UF2:1708032 bytes, SHA256 `9bf7fd6bb9bc677e4f87aca9cc2ff4130abaf5455f89417b334b8f001d2fae99`.
- ug-full.zip: SHA256 `d9e29dad55624bcffd69c0fc3a9df965d9455d32e94466f5852a6ff38a13d989`.
- ug-host.zip: SHA256 `966dd5fcd67ed6106364b54f8a322e83dd89fe3e9d31fe713c6294b908b42daa`.
- ug-host.img: SHA256 `0aec5e5760c062cb7dc62f4f7a18a54180de7755ddacaaa0373c6cbe4297c8b4`.

Read-only UGP0/UGP1 опубликованы рядом и в BOOTPROB.ZIP/IMG;80 diagnostic
actual-EXE cases/byte identity пройдены отдельно. Они не включены в девять
production EXE. Аппаратного PASS R3 пока нет.
