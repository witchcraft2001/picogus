# S8a: MOD8/8CHN, независимые FX и фоновые операции

MOD F00: UGPLAY/UGPF продолжают после F00 по умолчанию; `/F00:PAUSE`
задаёт паузу. Проверка исходного BST.MOD и новые fixtures описаны в F00.TXT
([исходник инструкции](F00-README.md)). Нужен комплект с capability bit12.

HOST_PASS / REAL_PENDING. Требуется новая прошивка CURRENT.UF2 и согласованные
EXE из CURRENT.ZIP либо CURRENT.IMG. Все файлы выдаются в постоянном build/;
UF2 и IMG не вложены в ZIP. IMG — диск данных FAT12, не загрузочный DSS.
Исходные15-секундные MONO22/STEREO22 сохранены в ZIP; в IMG только короткие
S8a fixtures и утилиты, чтобы уложиться в1.44 МиБ.

Поддерживаются M.K./M!K! (4 канала) и 8CHN (8). У 8CHN строки interleaved,
32 байта, паттерны 2048 байт; панорама L,R,R,L,L,R,R,L. Исходные MOD и samples
сохраняются побайтно. FLT8 теперь реализован отдельным этапом S8b; см. S8B-README.md.
API1/VLS1 сохранён: INFO40, CAPS44, SNAPSHOT64, u16 voice/instance IDs,
общий пул32. MOD8 резервирует8 голосов; тест8+4 не ограничивает FX четырьмя.
CAPS.formats bit4 включён; S8b также включает bit5 для FLT8. SET_PAN принимает каналы0..7 MOD8.

GS 63/64 читают первые четыре естественных канала. Исторические GS FX заменяют
MOD0/3/1/2; состояние скрытого канала продолжает идти, каналы4..7 независимы.
Это не расширение исторического GS wire reply до8 байтов.

## Короткая проверка

После прошивки и холодного включения выберите ULTRAGS обычным UGCFG. Затем:

```text
UGCFG INFO
UGMEM INFO
UGTEST PCM
UGTEST MOD8
UGTEST MOD8 /VERIFY
UGLOAD EIGHT.MOD /TYPE:MOD /VERIFY
UGPLAY HANDLE <напечатанный-handle> /LOOP
UGMON /COUNT:10 /HZ:5
UGTEST FX /SECONDS:10
UGTEST FX /SECONDS:10 /VERIFY
UGDUMP <mod-handle> BACK.MOD /VERIFY
UGPLAY PAUSE
UGPLAY RESUME
UGPLAY STOP
UGMEM FREE <mod-handle>
```

UGTEST MOD8 создаёт собственный небольшой модуль, проверяет восемь записей
голосов, PAUSE/RESUME и освобождает объект. Требует свободного foreground и
отсутствия FX; чужую музыку не замещает. MOD8 /SECONDS не поддерживается.

UGTEST FX при активном MOD8 сначала запускает4 mono, затем2 stereo FX, все
S16LE/48000. Проверяет независимые PAUSE/RESUME, фоновые upload/SEAL/readback,
сохранение play_id/числа каналов и отсутствие новых CRC/underrun/PSRAM ошибок.
/SECONDS:N=1..3600 задаёт длительность КАЖДОЙ фазы, default60. Нужно минимум
четыре свободных голоса; тест не вытесняет чужие FX. Без активного MOD8 прежний
UGTEST FX остаётся коротким тестом заполнения общего пула/NO_VOICE;
/SECONDS в этом режиме возвращает ошибку состояния. /VOICES относится к MIX.

При ESC либо ошибке очищаются только временные объекты/instances теста.
Пользовательский MOD и ранее запущенные FX сохраняются. UGMON не останавливает
музыку при выходе. При потере PLAY_FX ACK cleanup находит принятый instance по
собственному object handle, без повторного PLAY и без STOP_FX ALL.

EIGHT.MOD — два паттерна с восемью разными нотами, продолжительность finite
15.36 секунды. FX8.WAV — mono, FXST.WAV — stereo с различимыми сторонами,
оба S16LE/48000, 0.25 секунды. Синтетические fixtures распространяются вместе
с исходным генератором под GPL-2.0-or-later. Они не заменяют реальные MOD.

## Физическая приёмка

Запустите EIGHT.MOD /LOOP, затем отдельно:

```text
UGTEST FX /SECONDS:600
UGTEST FX /SECONDS:600 /VERIFY
```

Каждая команда содержит два последовательных10-минутных прогона:4 mono и2 stereo.
Ожидаются8 различимых музыкальных каналов, различимые FX, непрерывный темп,
нулевые новые underruns/CRC/PSRAM errors и сохранение музыки после теста.
Сравните BACK.MOD с исходным EIGHT.MOD на ПК. Проверьте также пользовательский
8CHN с эффектами, короткими петлями и переключениями паттернов.

Дополнительная нагрузка: UGLOAD FX8.WAV /TYPE:WAV /VERIFY, UGDUMP играющего MOD,
UGBENCH /SOAK:600 и UGMON. Запишите команды, вывод, hashes комплекта, слот,
clk_sys/PSRAM clock, длительность и результат прослушивания. Физическое время
render quantum должно укладываться в75% длительности; HOST instruction count
не является измерением времени карты. Финальные30-минутные gates остаются открыты.

## Ограничения и регрессии

RESULT PASS теста означает прохождение выполненных программных проверок;
прослушивание, LRCLK/ISA/PSRAM timing и температура требуют реального стенда.
S8a не ACCEPTED до физической проверки. Общая приёмка S6/S7 также не закрывается.

Оптимизация streaming отложена. Сохраняются подтверждённые REAL_FAIL S8c:
SHORT.WAV44100/S16/stereo —10 underrun при256/128 КиБ и5 при512/256;
последний1-секундный контроль —1 underrun. Измеренные DISK284475,
UGPF FEED141852–142160 и UGPLAY FEED86994 Б/с не достигают обязательной подачи
220500 Б/с для44100/S16/stereo. Команды STREAM и BENCH сохраняются;
форматы/команды подробно описаны в S8C.TXT и S8C-README.md.

Повторяемые HOST команды: make -f Makefile.ultrags s8a-host, test-dss;
node tests/ultrags/dss/run-s8a.mjs . build; tools/ultrags/s8a-arm.py --build build.
ARM runner требует Unicorn2.1.4 и arm-none-eabi-nm в PATH. Отчёт и hashes:
build/DELIVERY.json, build/evidence/s8a-exe.json, build/evidence/s8a-arm.json,
build/host/s8a/host-evidence.json. Независимая сборка: build/reproducibility/.
