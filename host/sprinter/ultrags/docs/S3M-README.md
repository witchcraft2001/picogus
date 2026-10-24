# S3M PCM - проверка на Sprinter

Статус поставки: HOST_PASS / REAL_PENDING. Это PCM-профиль Scream Tracker 3
с mono/planar stereo, signed/unsigned 8/16 bit, петлями и панорамой.
FM-инструменты внутри S3M и packed samples не поддержаны. Независимый OPL2
остаётся доступен. Старые аппаратные REAL_FAIL streaming и AdLib сохранены.

## Первый запуск

Установите CURRENT.UF2 обычным способом. Скопируйте файлы CURRENT.ZIP или
используйте CURRENT.IMG. UF2 и IMG не вложены в ZIP. Все S3M в комплекте -
собственные генерируемые тестовые файлы, сторонняя музыка не распространяется.
Для slot 1 добавляйте `/SLOT:1` ко всем утилитам ниже.

```text
UGCFG ULTRAGS
UGCFG INFO
UGMEM INFO
UGPLAY DEMO.S3M /VERIFY /WAIT
UGPLAY DEMO.S3M /GS /VERIFY /WAIT
UGLOAD STU16.S3M /VERIFY
```

GS31 сохраняет циклическое воспроизведение: из `/GS /WAIT` выходите по ESC.
У обычного native `/WAIT` короткий DEMO завершается сам.

Запомните напечатанный handle (далее пример для 1):

```text
UGDUMP 1 BACK.S3M /VERIFY
UGPLAY HANDLE 1 /LOOP
UGMON /COUNT:10
UGPLAY PAUSE
UGPLAY RESUME
UGPLAY STOP
UGMEM FREE 1
UGMEM INFO
```

Ожидается: OBJECT_INFO kind5, проверка CRC/readback PASS, tracker kind2,
один логический канал и два голоса у STU16; музыка слышна в обоих каналах,
правый имеет вдвое более короткий период волны. STOP и FREE возвращают
всю память, включая служебный индекс. Звук после PAUSE/RESUME продолжается.
Повторите с MOU8.S3M и обоими слотами. Явный формат: `/TYPE:S3M` допускает
имя FILE.DAT. `/F00:IGNORE` и `/F00:PAUSE` для S3M должны дать ошибку синтаксиса.

## Голоса, эффекты и FM

M32.S3M использует 32 mono-голоса, S16.S3M - 16 stereo-каналов/32 голоса.
Во время их LOOP дополнительный native FX должен получить NO_VOICE,
музыка при этом продолжается. У DEMO.S3M четыре mono-канала: независимый FX
можно добавить из обычного WAV, затем остановить по его instance_id.

OPL2 не расходует PCM-голоса. Для совместного теста запускайте внешний
OPL2-плеер через 0388h/0389h вместе с S3M; выключайте FM его собственным
key-off. UGOPL MIX имеет свой MOD8 и заменит foreground, поэтому эта команда
не является тестом совместного S3M/OPL2. Для диагностики UGOPL учитывайте
действующие ограничения ADLIB.TXT (включая Turbo OFF для status reads).
Direct GS FX на первых четырёх каналах временно заглушает музыкальный канал
целиком, включая обе stereo-половины; после эффекта музыка продолжает фазу.

В S3M поддержаны A-L, O, Q-V, X00..80; подкоманды S1/S2/S3/S4/S8/SB/SC/SD/SE.
Fine/extra-fine pitch, ST3.00 volume slides и память параметров включены.
T00..1F не являются IT tempo slide. Random waveform имеет свой детерминированный
генератор. FM/packed, M/N/P/W/Y/Z, S5..7/S9/SA/SF, waveform>3, surround XA4,
дополнительные header flags/special pointer возвращают FORMAT при SEAL/D2.

## ASM-примеры и очистка

На пустой карте запустите `S3M0` (native) и `GSS3M0` (GS); для slot 1 -
`S3M1` и `GSS3M1`. Они содержат небольшой собственный S3M, проверяют CAPS,
полный readback и snapshots, играют 1-2 секунды и освобождают объект.
Ожидается `S3M: uploaded, read back, played, freed` и неизменная свободная память.
ESC тоже должен вернуть управление и освободить данные. При чужом объекте
пример отказывается с BUSY. Исходники: examples/s3m.asm, gss3m.asm и s3m_demo.inc;
руководство - ULTRAGS.PDF в ZIP и docs/ULTRAGS-PROGRAMMING.md в репозитории.

## Аппаратная приёмка

Зафиксируйте hashes CURRENT.*, slot, BIOS/DSS и настройки Turbo. Прослушайте
mono/stereo, смену инструмента, петли, эффекты и позиционирование. Снимите
STATS до/после длительного совместного воспроизведения S3M+FX+OPL2: нужны
нулевые приращения audio_underruns и psram_errors и физический render deadline
<=2667 мкс при quantum128/48kHz. Проверьте возврат DSS после EOF/ESC/ошибок.
При 32 голосах проверьте также голосовой отказ без прерывания музыки.
До этих измерений software PASS не означает отсутствие underrun на карте.

Host-доказательства: build/host/s3m/, включая libxmp4.7.0 ticks, аналитические
PCM-тесты, реальные Z80 EXE на DSS-модели, связанный Cortex-M0 код и бюджеты.
Крайние C2SPD/ноты проверяются аналитически: диапазон транспозиции libxmp
отличается. Для обычных частот допускается расхождение периодов 0,3% или
одна единица ST3; транспорт, ноты, громкости и панорама сравниваются точно.
Сборка: s3m-check в двух фиксированных деревьях, затем s3m-package.
