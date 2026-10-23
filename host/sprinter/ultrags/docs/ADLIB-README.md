# AdLib OPL2 в UltraGS

## R3 (2026-10-23): причина нестабильного CONFIG и исправление

Кандидат: `pg-ultrags-adlib-r3 v4.1.1`, файл `build/CURRENT.UF2`
(1756160 bytes, SHA-256 `0e37aad8b428f9d813010d71597f0d5b3a62915210828e4474c378604fba96fc`);
`build/multifw-release` и `build/reproducibility` побайтно совпали.
EXE не менялись: UGCFG.EXE/UGOPL.EXE/UGOPLD.EXE те же, что в R2/R3-diag.

**Что было не так в adlib-r1/r2 (ревью кода):**

1. Таймеры OPL опрашивались в главном цикле core0 (`ug_opl_poll`: чтение
   таймера RP2040, умножения и деление по модулю, ~100+ тактов) на каждой
   итерации, пока запущен незамаскированный таймер. Каждая итерация цикла —
   промежуток между захватом цикла шины и ответом IOCHRDY; CONFIG и 0388h
   удерживаются программно, их запас при Turbo OFF около 200 нс. После старта
   таймера (детект AdLib, таймерная стадия UGOPL TEST) любое чтение
   CONFIG/0388h могло уйти в FF. Проверка `!ior_has_data()` не защищает:
   захват, пришедший сразу после неё, ждёт весь опрос.
2. Чтение статуса 0388h шло «чужим» путём PIO (IOCHRDY от ARM, 150–250 нс),
   то есть в Turbo (окно ~105 нс) оно не укладывалось принципиально — как GS
   до R17. UGOPL TEST по умолчанию ведёт FM-обмен с Turbo ON, поэтому
   таймерная стадия в Turbo была обречена.
3. Ветка 0388h стояла в `handle_ior` раньше диспетчеризации CONFIG (лишнее
   сравнение на самом критичном пути), а кэш скаляров CONFIG обновлялся до
   IO_END записи, удлиняя её удержание.

**Что сделано в R3:**

- Таймеры: истечение детектирует одноразовый аппаратный alarm 0 core0
  (TIMER_IRQ_0). Флаг переполнения липкий до сброса, поэтому на один
  старт/сброс таймера приходится одно короткое прерывание; в цикле опроса ISA
  кода таймеров больше нет. Регистры 2–4 применяются синхронно с записью при
  запрещённом прерывании; переполненная очередь синтеза повторяет попытку с
  разрешёнными прерываниями.
- PIO: пока BULK alias выключен (по умолчанию), его слот классификатора
  владеет блоком 0380h–039Fh — IOCHRDY для 0388h утверждается в PIO за ~30 нс,
  как для BASE и GS. Бюджет pio0 (IOW10 + IOR22 = 32 слова) не изменился.
  **Ограничение:** при включённом BULK alias 0388h возвращается к
  программному удержанию, то есть чтение статуса OPL надёжно только при
  Turbo OFF. Запись 0388h/0389h от alias не зависит.
- `handle_ior`: сначала CONFIG, затем 0388h; кэш скаляров CONFIG обновляется
  после IO_END записи.

Побочный эффект: при выключенном alias чтения прочих портов 0380h–039Fh
растягиваются до решения ARM и отпускаются с FF (на Sprinter устройств там
нет). Порт 0389h не читается (FF).

Что это не объясняет: на фото 09:01 (adlib-r1, INFO без запущенных таймеров)
четыре скалярных чтения после каталога вернули FF; конкретная строка кода,
ответственная именно за этот случай, статическим разбором не найдена. R3
сокращает худший путь core0 до уровня R17 и убирает оба найденных механизма
отказа; подтверждение — только стенд.

**Программные проверки R3 (все PASS):** compat-check (524288 адресов;
0388h удерживается в PIO при задержке ARM 8/128/4096 тактов, при alias=0280h —
отрицательный контроль), rp2040js 12288, config-exchange 213 операций
(owned/foreign 0388h, вызов alarm на каждую принятую запись, маскирование
прерываний), unit-тест OPL (deadline, оба таймера, wrap, маска), adlib-arm
19 OPL + 6 смешанных профилей, adlib-read-linked (9/8/14 инструкций до FIFO
для OPL/scalar/FWSTRING, без timer MMIO), run-adlib 84 EXE-сценария,
run-gs-turbo 56, compat-linked (идентичные UF2, identity r3), legacy OPL
sections exact, SRAM free 62692.

**Проверка на Sprinter:**

1. Прошить `build/CURRENT.UF2` при выключенном Sprinter.
2. `UGCFG INFO /SLOT:0` три раза подряд: `pg-ultrags-adlib-r3 v4.1.1`,
   ULTRAGS, BASE 02A0, PASS каждый раз.
3. `UGCFG INFO /DIAG /SLOT:0`.
4. `UGOPLD TEST /SLOT:0 /TURBO:OFF /SECONDS:10`, затем `/TURBO:ON`.
   Ожидается прохождение таймерной стадии в обоих случаях (BULK alias OFF).
5. `UGOPL MIX` по прежнему плану.
При отказе сохранить весь вывод и строку версии.

Программная приёмка и аппаратная приёмка раздельны. До подтверждения владельцем
REAL_PENDING. Исторический S8c REAL_FAIL сохранён; эта поставка не исправляет
дисковую подкачку. Точные результаты и hashes: ADLIB.json и DELIVERY.json.

Аппаратный отказ 2026-10-23 сохранён: повреждённая строка UGCFG INFO,
UGOPL TEST code9 без звука с Turbo ON/OFF; последующий запуск дал code3
MEMORY_OR_PROTOCOL. ADLIBTST.EXE из picogus-support воспроизвёл четыре ноты,
но его исходник не читает статус и не проверяет таймеры. Причина ещё не доказана.
Кандидат R2 имел строку `pg-ultrags-adlib-r2 v4.1.1`; PIO COMPAT R17
сохранён (R3 выше меняет слот alias в PIO). Для 0388h выдаётся готовый SRAM-статус, таймеры обновляются на core0
вне ответа; FWSTRING выдаётся коротким путём с продвижением после FIFO.

UGOPL diagnostic R3 CRC=ON проверяет CRC всех native RPC, включая INFO/CAPS.
При отказе до cleanup печатает `OPL DIAG R3 phase=XX caps=XXXXXXXX`:
01 DISCOVER,02 OPEN,03 INFO RPC,04 INFO magic,05 layout,06 CAPS RPC,
07 память,08 ADLIB_OPL2,09 SNAPSHOT,0A таймеры,0B воспроизведение.
FFFFFFFF означает, что проверенный CAPS ещё не получен. Code3 с
ADLIB_CAP_MISSING или MEMORY_CAP_MISSING отличает отсутствующий флаг;
code9 NATIVE_FRAME_CRC означает повреждение ответа. Отказ таймера дополнительно
печатает `OPL TIMER stage=XX reset=XX timer1=XX timer2=XX` и OPL_TIMER_STATUS.
При phase02 R3 дополнительно печатает `OPL OPEN stage=XX base=XXXX error=XX
values=XXXXXXXXXX`: stage01 окно,02 magic,03 protocol,04 active mode,
05 alias,06 API major,07 API minor. Values — последние прочитанные
magic/protocol/active/major/minor по порядку; ожидаются DD04080100,
непрочитанные поля FF. Повторных чтений для диагностики нет.
Владелец на диагностическом EXE R2 сообщил phase02 capsFFFFFFFF code3: отказ до INFO/CAPS/FM.
Ступени таймера01/02/03 — сброс/timer1/timer2; FF также обозначает ещё не измеренный байт.
Для диагностики той же установленной прошивки отдельная копия нового EXE
выдаётся как `build/UGOPLD.EXE` (те же bytes, что UGOPL.EXE):
`UGOPLD TEST /SLOT:0 /TURBO:OFF /SECONDS:10`.
Проверить наличие баннера R3 и сохранить весь вывод. Эта проверка ещё не
требует замены установленной прошивки.

История: на gsturbo-r17 диагностический R3 дошёл до timer1FF после reset06.
На adlib-r1 строка версии стала правильной, но 09:01 INFO вернул BASEFFFF,
следующий /DIAG дал PASS; затем TEST отказал в OPEN stage04 с FW_ACTIVE=FF.
Эти отказы остаются REAL_FAIL. R2 подготавливает чистые CONFIG scalar replies
до чтения и обновляет их после выбора/commit; RESULT/BUSY остаётся живым,
потребляющие FWSTRING/catalogue сохраняют отдельные пути. PIO R17 прежний.

Проверка R2/R3 требует обновить и прошивку, и UGCFG.EXE из нового комплекта
(актуальный UF2 — R3, см. начало документа; R2 был
SHA256caa6dff34f9d681fe48cd53244d9f9724fb32351b898710c970f2a0127a50d2a);
UGCFG.EXE — 9688 bytes,
SHA2561d24eb508f5ad6d45f87a8a07640e496dae2f66fbef9988331a8d7eb74e916e5.
Новый UGCFG отвергает недопустимые desired/active/GS значения с code9
CONFIG_SCALAR: FF не считается ON. /DIAG печатает сырые active/desired/boot/gs.
Legacy INFO без допустимого UltraGS-каталога сохраняет прежний read-only путь.

Сначала трижды выполнить UGCFG INFO /SLOT:0: каждый раз ожидаются
pg-ultrags-adlib-r3 v4.1.1, ULTRAGS, BASE02A0 и PASS. Затем
UGCFG INFO /DIAG /SLOT:0 и UGOPLD TEST /SLOT:0 /TURBO:OFF /SECONDS:10.
UGOPLD.EXE/UGOPL.EXE остаются той же диагностической R3. Сохранить версию,
все RESULT и OPL TIMER/DIAG. После устойчивого TEST — Turbo ON; MIX только
после устойчивого CONFIG/TEST. Аппаратные звук/тайминги/30min остаются REAL_PENDING.

OPL2 постоянно доступен в UltraGS на 0388h/0389h. BASE/ALIAS 0380h запрещены.
CAPS.features bit13 (8192) обозначает ADLIB_OPL2. CMD_OPLPORT читает 0388h;
изменение адреса в UltraGS отклоняется. Девять FM
каналов и percussion не занимают общий пул PCM. OPL3/S3M не добавлены.

UGOPL TEST проверяет обнаружение и оба таймера, включает девять мелодических
каналов и чередует мелодический режим с percussion. RESULT PASS означает
прохождение программных проверок; различимость нот и ударных слушает владелец.
Тест явно задаёт NOTE-SEL, melodic mode, waveform и feedback/connection,
поэтому прежние настройки AdLib не меняют тестовый тембр; девять каналов
получают разные частоты. TEST/MIX заменяют предыдущее состояние FM.
UGOPL MIX загружает собственный MOD8 и четыре mono либо два stereo FX,
добавляет девять FM-каналов и проверяет счётчики underrun/data errors.
Перед выдержкой MIX очищает накопленные счётчики. В конце печатает
max_render_us, underruns, psram_errors, protocol_errors и clips;
max_render_us>2667 возвращает code7, ненулевые ошибки — code9. Clipping выводится, но не приглушается.
При появлении ошибки во время MIX тест также печатает итоговые счётчики.
При занятом PCM-проигрывателе или активных FX MIX возвращает BUSY без их остановки.

Выбрать UltraGS для установленного слота; второй слот проверять при
соответствующем подключении карты. Пример команд:

```
UGCFG ULTRAGS /SLOT:0
UGOPL TEST /SLOT:0 /TURBO:ON /SECONDS:10
UGCFG ULTRAGS /SLOT:1
UGOPL TEST /SLOT:1 /TURBO:ON /SECONDS:10
UGOPL MIX /FX:MONO /SLOT:0 /TURBO:ON /SECONDS:1800
UGOPL MIX /FX:STEREO /SLOT:0 /TURBO:ON /SECONDS:1800
```

Повторить MIX для второго слота; при диагностике повторить с /TURBO:OFF.
По умолчанию TEST/MIX используют slot0, Turbo ON,10s, mono FX.
/SECONDS:1..1800. ESC прекращает тест с code10. Нормальный выход — code0,
восстановление PAGE3/IFF/стека, возврат приглашения DSS, освобождение своих
объектов и выключение тестового FM. DSS вызывается с закрытым ISA-окном.
Turbo-параметр относится к FM-обмену; native RPC сохраняет прежний Turbo OFF.
Как и существующая DSS-библиотека, закрытие окна возвращает стандартное DSS
состояние software Turbo ON: write-only аппаратный регистр не читается как
снимок начальной скорости. Аппаратное разрешение Turbo не изменяется.

Аппаратная приёмка: существующий AdLib-тест picogus-support в Turbo; оба слота;
два30-минутных MIX-профиля без непредусмотренных underrun/ошибок данных.
Проверить громкость OPLVOL и MAINVOL, мелодии/percussion/release, отсутствие
скрежета, независимость STOP/PAUSE MOD и FX. Измерить max_render_us полного
кванта: <=2667us. MOD до32ch+FM — дополнительный нагрузочный замер.
Не понижать громкость автоматически ради прохождения проверки: при намеренно
высоких уровнях clipping учитывается по окончательной смеси. Если слышен
обрыв или искажение, сохранить hashes установленных файлов, команды,
slot/BIOS/DSS/настройки Turbo и вывод счётчиков. Программный PASS не подтверждает
электрический запас ISA и качество аналогового звука.

Сборка: make -f Makefile.ultrags adlib-check в build/ и с REPRODUCIBILITY=1;
затем adlib-package проверяет свежесть evidence, независимое совпадение бинарников
и повторное извлечение ZIP/FAT12 до публикации CURRENT.*.

Разработчику: перед первой проверкой сохранить прежний CURRENT.UF2 в
`build/archive/pre-adlib/CURRENT.UF2` (или задать UG_ADLIB_BASELINE). Для
полного регрессионного набора задать UG_PROPLAY, UG_PROPLAY_MOD, UG_F00_MOD,
UG_MULTIMOD и UG_FLT8_MOD на неизменённые частные оригиналы из предыдущих
GS/S8b проверок; эти файлы в комплект не включаются. UG_AUDIO_PYTHON должен
запускать Python с Unicorn2.1.4, а PATH — содержать arm-none-eabi инструменты.
