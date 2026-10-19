# SAVE ULTRAGS: новая UF2, 2026-10-19

**Установить новую PGMULTI.UF2 из этого комплекта.** UGCFG.EXE с полем
save_result_ff_reads уже подходит; EXE после последнего ZIP не менялись.
Предыдущая host-only правка не устранила весь сбой: BUSY получен, затем
восемь FF и повреждённый9F. Предыдущая UF2 f5 не содержит новой правки.

В SAVE ULTRAGS/RP2040 сохраняется clk_sys370МГц. Проверены compiled boot2 /4
и ROM command /6: Flash работает на92.5/61.7МГц без переключения обоих ядер
и ISA PIO на240/48МГц. Код erase/program/readback, протокол4, API1.0,
Settings v6 и CLI прежние. GUS/остальные режимы не переводятся на новый путь.
Собранный ARM-код и C-мутации проверяются до поставки; физические margins
не измерены. Источник ROM для аудита, не для линковки:
https://github.com/raspberrypi/pico-bootrom-rp2040/blob/ef22cd8ede5bc007f81d7f2416b48db90f313434/bootrom/program_flash_generic.c

После прошивки, для того же слота (slot0 по умолчанию):

```text
UGCFG ULTRAGS
UGCFG VERIFY
UGMEM INFO
```

При PASS всех команд выполнить **один раз**:

```text
UGCFG SAVE /DIAG
```

Ожидается подтверждение сохранения, RESULT PASS; save_seen=01.
Сфотографировать весь вывод с save_result_ff_reads, даже при PASS.
При FAIL сохранить UGCFG INFO /DIAG и не повторять SAVE автоматически.
Для второго слота добавлять /SLOT:1 ко всем командам. Тесты 8МиБ уже прошли,
повторять длительные ROUNDTRIP для этой правки не требуется.

После PASS снять всё питание Sprinter/PicoGUS, включить и выполнить:

```text
UGCFG
UGCFG VERIFY
UGMEM INFO
UGCFG GUS
UGCFG
```

Сначала должны быть ULTRAGS/READY, boot_result00 и свободные8388608 bytes;
последняя INFO подтверждает GUS. SAVE при возврате в GUS здесь не требуется.
Фактическая запись и холодный старт старой версии ранее подтверждены;
новое подтверждение SAVE, остальные открытые gates — REAL_PENDING, S7 IN_PROGRESS.
