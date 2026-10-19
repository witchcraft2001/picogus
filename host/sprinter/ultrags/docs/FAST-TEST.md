# UGMEM: сравнение скорости, 2026-10-19

Перепрошивать карту не нужно. Оставить рабочую f5bf0bfdde03...; полный hash:
f5bf0bfdde03bb28b2a90d2e791d4b0c3ed702e5000a92108bd623a7a9e5c2bb.
Скопировать шесть EXE из ug-fast.zip/img. CLI одинаковый. По умолчанию slot0;
для второго слота добавлять `/SLOT:1` ко всем командам. Модель проверила
исполняемые EXE; физическая скорость новых вариантов ещё REAL_PENDING.

| EXE | Максимум bytes в окне | Turbo записи BULK | Turbo чтения |
|---|---:|---|---|
| UGMEM | 8 | off | off |
| UGM64 | 64 | off | off |
| UGM256 | 256 | off | off |
| UGM8T | 8 | on | off |
| UGM64T | 64 | on | off |
| UGM256T | 256 | on | off |

Файл с T включает Turbo только внутри окна записи разрешённого BULK payload;
request/config/GS_DATA и все чтения работают с Turbo off. Аппаратный запрет
Turbo сохраняет силу. Обычный UGMEM сохраняет проверенный режим 2 → ISA → 3.
Увеличено окно, а размер BEGIN→END блока остаётся максимум 1024 bytes.

Сначала короткое сравнение, без SAVE:

```text
UGMEM ROUNDTRIP 65536 /VERIFY
UGMEM INFO
UGM64 ROUNDTRIP 65536 /VERIFY
UGMEM INFO
UGM256 ROUNDTRIP 65536 /VERIFY
UGMEM INFO
```

Если всё PASS, проверить Turbo-запись:

```text
UGM8T ROUNDTRIP 65536 /VERIFY
UGMEM INFO
UGM64T ROUNDTRIP 65536 /VERIFY
UGMEM INFO
UGM256T ROUNDTRIP 65536 /VERIFY
UGMEM INFO
```

Сфотографировать полные результаты с elapsed_s и именем запущенного EXE.
Ожидаются PASS, objects=0, free=8388608 после каждой команды. При первом
отказе сохранить transfer_stage/moved/offset/source/status и INFO; следующий
эксперимент не запускать. Выбор быстрого варианта — только после этих результатов.
Затем повторить подходящий вариант на 1048576, и при успехе на 8388608 bytes
с `/VERIFY`. Сравнивать одинаковые размер и /VERIFY, входное состояние Turbo,
слот и разрешение аппаратного Turbo. ESC должен отменять команду и освобождать
объект; после отмены проверить INFO. Не применять /QUIET для замера фаз.

Текущий физический эталон: предыдущий UGMEM db9840b8a005... на f5 firmware,
8-МиБ FAST PASS за 1001 с (WRITE 473 с), INFO — все 8 МиБ свободны.
Числа из модели EXE отражают инструкции хоста без задержек ISA/ARM и не являются
прогнозом времени Sprinter. Окно 256 удлиняет непрерывный участок DI; его
электрические пределы, работа под аудионагрузкой и Turbo-запись требуют стенда.
Протокол4/API1.0/Settings/CLI не менялись. REAL_PENDING, S7 IN_PROGRESS;
SAVE/power cycle и полный приёмочный прогон остаются отдельными проверками.
