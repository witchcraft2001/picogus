# WAV IMA ADPCM — проверка на Sprinter

Статус: HOST_PASS / DSS-EXE_PASS / REAL_PENDING.

Карта принимает WAV со сжатием IMA ADPCM (кодек 0x11, 4 бита на отсчёт)
так же, как обычный PCM WAV: загрузка `/TYPE:WAV`, запуск как основной звук
или как эффект поверх музыки. Файл занимает в памяти карты и грузится
примерно в 4 раза быстрее, чем 16-битный PCM. Распаковка идёт на карте во время
воспроизведения.

DSS-утилиты не менялись: подходят EXE из `build/CURRENT.ZIP` или
`build/CURRENT.IMG`. Нужна прошивка `build/CURRENT.UF2`, SHA-256
`380887597fd93ac9c8bac5299a0781b07697b3f6d7f27707fc01afd9318b1461`.
Прежний UF2 сохранён в `build/archive/pre-adpcm/CURRENT.UF2`.

## Что поддержано

| Параметр | Значение |
|---|---|
| Кодек | WAV format 0x11 (IMA/DVI ADPCM, раскладка Microsoft) |
| Каналы | mono, stereo |
| Частота | 8000–48000 Гц |
| Размер блока | до 8192 байт, кратный 4 байтам на канал |
| Воспроизведение | PLAY_PCM и PLAY_FX, повторы, повтор всего файла |
| CAPS.formats | бит 8 |
| OBJECT_INFO | bits=4, sample_format=3 |

Не поддержано: RAW ADPCM без заголовка, ADPCM в потоке STREAM, Microsoft
ADPCM (кодек 0x02), OKI/VOX ADPCM.

## Как сделать файл

```text
ffmpeg -i source.wav -c:a adpcm_ima_wav out.wav
ffmpeg -i source.wav -ar 22050 -c:a adpcm_ima_wav -block_size 1024 out.wav
sox source.wav -e ima-adpcm out.wav
```

## Тестовые файлы

Набор лежит в `build/host/adpcm/kit/`, хеши в `SHA256.TXT`. Все файлы
синтетические, их создаёт `tools/ultrags/gen-adpcm.py` через ffmpeg.

| Файл | Содержимое |
|---|---|
| M11K.WAV | ADPCM, 11025 Гц, mono, блок 256, 0,7 с |
| S22K.WAV | ADPCM, 22050 Гц, stereo, блок 2048, 0,9 с |
| S44K.WAV | ADPCM, 44100 Гц, stereo, блок 1024, 0,4 с |
| M48K.WAV | ADPCM, 48000 Гц, mono, блок 1024, 0,5 с |
| M11KP.WAV, S22KP.WAV, S44KP.WAV, M48KP.WAV | Тот же звук в 16-битном PCM, декодированный ffmpeg |
| BAD.WAV | M11K.WAV с испорченным размером блока |

Пары `xxx.WAV` и `xxxP.WAV` должны звучать одинаково: карта обязана выдать
тот же сигнал, что и PCM-версия.

## Проверка

Скопируйте файлы набора на Sprinter. Для второго слота добавьте `/SLOT:1`
ко всем командам.

```text
UGCFG ULTRAGS
UGCFG INFO
UGMEM INFO
UGLOAD M11K.WAV /TYPE:WAV /VERIFY
UGPLAY HANDLE 1 /WAIT
UGPLAY FXHANDLE 1 /WAIT
UGDUMP 1 BACK.WAV /VERIFY
UGMEM FREE 1
UGPLAY S22K.WAV /WAIT
UGPLAY S22KP.WAV /WAIT
UGPLAY S44K.WAV /WAIT
UGPLAY S44KP.WAV /WAIT
UGPLAY M48K.WAV /WAIT
UGPLAY M48KP.WAV /WAIT
UGPLAY BAD.WAV
```

Ожидается:

- UGLOAD печатает `type=WAV state=READY ... bits=4 format=3` и `RESULT PASS code=0`.
- HANDLE и FXHANDLE доигрывают звук до конца без щелчков и обрывов.
- BACK.WAV побайтно совпадает с M11K.WAV.
- Каждая пара ADPCM/PCM звучит одинаково.
- BAD.WAV даёт `RESULT FAIL code=6 reason=FORMAT` и не играет.

Эффекты поверх музыки:

```text
UGPLAY EIGHT.MOD /LOOP
UGPLAY FX S22K.WAV
UGPLAY FX M11K.WAV /LOOP
UGPLAY FX S44K.WAV
UGMON /COUNT:20
UGPLAY FXSTOP ALL
UGPLAY STOP
```

Ожидается: музыка играет без изменения темпа и без провалов, эффекты слышны
поверх неё, UGMON показывает underruns=0.

Запишите версию BIOS/DSS, слот, хеши UF2 и EXE, вывод команд и впечатление
от прослушивания пар ADPCM/PCM.

## Host-проверки

```sh
make -f Makefile.ultrags adpcm-check
```

Цель генерирует фикстуры ffmpeg, собирает под UBSan тест разбора и микшера
(`tests/ultrags/unit/test_ima_render.c`) и тест через команды карты
(`tests/ultrags/unit/test_ima_storage.c`), затем прогоняет 60 сценариев
настоящих EXE (`tests/ultrags/dss/run-adpcm.mjs`). Отчёты лежат в
`build/host/adpcm/`. Проверка слинкованного кода Cortex-M0+ с ADPCM-профилями
входит в `tools/ultrags/audio-render-check.py` (нужен Unicorn 2.1.4).
