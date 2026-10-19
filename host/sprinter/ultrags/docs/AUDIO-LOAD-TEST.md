# MOD и два stereo FX: исправление нагрузки, 2026-10-19

Для последующей правки записи DSS и файловых окон см. FILEIO.TXT в комплекте.
Инструкции перепрошивки ниже относятся к исходной поставке audio/load.

Постоянная поставка: `build/latest/`. Нужна новая `PGMULTI.UF2` и новые
`UGLOAD.EXE`, `UGDUMP.EXE`, `UGPLAY.EXE`. UGCFG/UGMEM/UGMON/UGTEST прежние.
В полном `ug-cfg.zip` находятся все согласованные EXE. Сохранён исправленный
путь SAVE без переключения clk_sys; остальные шесть mode images не меняются.

В ARM-цикле микшера убраны 64-битные деления панорамы, сокращены вычисления
gain/interpolation, объединены попадания двух taps в cache. Округление и
сэмплы сохраняются точно: независимый HOST oracle, exhaustive math, linked
Cortex-M0 instruction execution. В UGLOAD/UGDUMP/UGPLAY добавлен byte-table CRC.
В исходной поставке ISA cap8/Turbo off; последующие файловые окна описаны в
FILEIO.TXT. Протокол4/API1.0/Settings и существующий CLI сохраняются.

## Что показал предыдущий прогон

`FX66_WAV.WAV` — synthetic stereo S16LE 44100 Hz, 882 frames (20 ms), а не
запись звукового эффекта. Один instance занимает lanes8/9, второй10/11.
Третий закономерно даёт NO_VOICE; четыре instance допустимы для mono.
Этот ожидаемый отказ может увеличить protocol_errors; сам счётчик после
NO_VOICE не доказывает повреждение обмена. Рост underruns и хрип — REAL FAIL.
Clips считает перегрузку суммы; регуляторы/масштаб сигнала не менялись скрыто.
На прежних фото clips рос до запуска FX. Новый mixer выдаёт прежние значения
при тех же данных/gain, поэтому исправление deadline не обещает устранить
перегрузку входного материала. Качество звука и реальные сроки — REAL_PENDING.

## Короткий повтор на карте

После прошивки используйте тот же `ATDT.MOD` и `FX66_WAV.WAV`. Переключение
должно начать новую session. Обозначения M/W ниже заменить object handles.

```text
UGCFG ULTRAGS
UGLOAD ATDT.MOD /TYPE:MOD /CRC:11C38894
UGPLAY HANDLE M /LOOP
UGMON /COUNT:3 /HZ:1
UGLOAD FX66_WAV.WAV /TYPE:WAV /VERIFY
UGPLAY FXHANDLE W /LOOP /GAIN:16
UGMON /COUNT:3 /HZ:1
UGPLAY FXHANDLE W /LOOP /GAIN:16
UGMON /COUNT:5 /HZ:1
UGMEM ROUNDTRIP 65536 /VERIFY
UGDUMP M BACK.MOD /VERIFY
UGMON /COUNT:3 /HZ:1
UGPLAY FXSTOP ALL
UGPLAY STOP
UGMEM FREE W
UGMEM FREE M
UGMEM INFO
```

BACK.MOD должен отсутствовать. CRC11C38894 относится только к файлу владельца
448248 bytes, SHA256 a91378987b0c7f64676302645a9e7f1d5cb7fbf6398ad4d0a0f8e03ba27675f2.
При другом MOD не копировать этот CRC; использовать /VERIFY или свой CRC.
`/CRC` проверяет полный файл на карте при SEAL, без Z80 CRC и полного обратного
чтения. `/VERIFY` сохраняет полный readback и ускорен табличным CRC; это разные
объёмы работы. Сравнивать скорость при одинаковых параметрах и данных.
Файл владельца не включён в поставку.

Ожидается underruns=0, psram_errors=0, audio_error=0, успешный обмен и сохранение
музыки. Clips фиксировать до/после, не выдавать их за underruns. В конце
free8388608/objects0. При FAIL сохранить команду и полный вывод, остановить тест.
Для отличия насыщения от ring/click можно затем повторить FX с /GAIN:8.
Сохранить фотографии и короткую запись звука при одном/двух FX.
SAVE и длинный 8-МиБ прогон для этой правки повторять не требуется.

## Разработчику: дополнительные software gates

В Python-окружении установить `tools/ultrags/requirements-audio-check.txt`;
`UG_AUDIO_PYTHON` задаёт этот интерпретатор (по умолчанию UG_PYTHON). На macOS
Unicorn JIT может требовать исполнения вне песочницы. cfg-check обязательно
исполняет linked ELF, проверяет oracle шести профилей и отсутствие 64-bit div
в них. AUDARM.JSN обязателен в комплекте; missing/failed/stale отвергаются.
Число ARM-инструкций не является измерением deadline: PSRAM, ROM copy и SIO
частично моделируются, bus/IRQ/SRAM arbitration и фактический timing остаются REAL.
Отдельный `audio-workload.py` проверяет private MOD/WAV на production C с
фоновым обменом и побайтным сравнением старого/нового результата, без включения
музыки в release. S6/S7 IN_PROGRESS; полная приёмка не объявляется.
