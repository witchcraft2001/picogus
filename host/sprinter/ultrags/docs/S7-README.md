# Ultra GS S7: native MOD4, промежуточная сборка

**S7 IN_PROGRESS.** Проверен native-сценарий MOD4 M.K./M!K!:
загрузка → READY handle → повторное воспроизведение → STOP → явный FREE.
CAPS.formats bit3 сообщает MOD4; CAPS.features bit0 (GS musical) выключен.
Полный GS 1.05, `/GS`, `UGTEST GS/MOD4` и нормативная аудиоприёмка ещё открыты.
Подробности и оставшийся объём — [S7-REVIEW.md](S7-REVIEW.md).

## Повторение проверок и сборка

Используйте закреплённые SDK, extras, GCC14.2.Rel1 и Python venv с зависимостями
из `tools/ultrags/requirements-build.txt`. На текущем стенде это:

```sh
export PICO_SDK_PATH=/Users/dmitry/dev/zx/sprinter/toolchain/pico-sdk
export PICO_EXTRAS_PATH=/Users/dmitry/dev/zx/sprinter/toolchain/pico-extras
export PATH=/Users/dmitry/dev/zx/sprinter/toolchain/armgcc/bin:$PATH
make -f Makefile.ultrags s7-native-package firmware ultrags BUILD=build/S7-review \
  UG_PYTHON=/Users/dmitry/dev/zx/sprinter/toolchain/py313/bin/python
```

`S7-native` проверяет текущий native subset. `s7-check` намеренно не объявляет
полный S7 успешным: после доступных проверок он сообщает об открытых GS/conformance
требованиях и завершает работу с ошибкой. Отчёт native-проверок:
`build/S7-review/REPORT-S7-NATIVE.txt`; JSON содержит hashes исполненных EXE,
исходников, заголовков, моделей и общих C/DSS-векторов. Старая PASS-запись удаляется
перед новым прогоном; verifier отвергает неполные/устаревшие результаты.

## Tester Notes: карта и Sprinter DSS

1. Прошейте карту **полным MULTIFW** файлом
   `build/S7-review/multifw-release/picogus.uf2` через обычный USB BOOTSEL способ
   для PicoGUS. Это именно собранный bundle с ULTRAGS. Имя `PGMULTI.UF2` относится
   к переименованным release-пакетам; в каталоге CMake файл называется
   `picogus.uf2`. После прошивки выключите питание и установите карту в Sprinter.
2. Перенесите на DSS диск EXE из
   `build/S7-review/ultrags/s7-native-package/ug-s7.img` или соответствующего ZIP.
   IMG — FAT12 data disk, не загрузочный диск DSS. `ST-*.EXE` — специально
   дефектные HOST self-tests, на Sprinter их не запускать.
   Все EXE при сборке и все файлы внутри ZIP/IMG имеют одинаковые имена **8.3**,
   без длинных имён и алиасов `~`. На Sprinter нужны `UGCFG.EXE`, `UGMEM.EXE`,
   `UGLOAD.EXE`, `UGDUMP.EXE`, `UGPLAY.EXE`, `UGMON.EXE`, `UGTEST.EXE`.
   Перечень коротких имён записан в `MANIFEST.TXT`; соответствие EXE исходникам
   ASM — в `build/S7-review/ultrags/dss/asm-manifest.json` на компьютере сборки.
3. Выполните `UGCFG INFO`, `UGCFG LIST`, затем `UGCFG MODE ULTRAGS /SAVE`.
   Ожидайте активный mode=8/ULTRAGS и готовую карту. `UGMEM INFO` должен показать
   реальную PSRAM; для исправной 8-МиБ карты — pool=8388608.
4. До запуска музыки выполните `UGTEST PCM`, затем `UGTEST FX`: ожидается
   `RESULT PASS code=0`. Положите на диск свой корректный 31-инструментный
   M.K./M!K! модуль с узнаваемой мелодией под именем `FOUR.MOD`.
   Синтетические файлы пакета сопоставлены с 8.3 именами в `MANIFEST.TXT`;
   некоторые из них намеренно повреждены и не являются музыкальным эталоном.
5. Проверьте native MOD4 в следующем порядке:

```text
UGLOAD FOUR.MOD /TYPE:MOD /VERIFY
UGMEM LIST
UGPLAY HANDLE <напечатанный-handle> /LOOP
UGMON /COUNT:10 /HZ:5
UGPLAY HANDLE <тот-же-handle> /LOOP
UGPLAY HANDLE <тот-же-handle> /LOOP /REPLACE
UGPLAY PAUSE
UGMON /COUNT:3
UGPLAY RESUME
UGPLAY STOP
UGPLAY HANDLE <тот-же-handle> /LOOP
UGPLAY STOP
UGMEM FREE <напечатанный-handle>
```

UGLOAD должен подтвердить проверку bytes и вывести object handle. UGPLAY печатает
отдельный `play_id`. Без `/WAIT` звук продолжается после возврата в DSS. UGMON
печатает `order,row,tick,speed,bpm`, ноты/периоды/peaks; position меняется при игре
и остаётся неподвижной на PAUSE. Повторный PLAY без `/REPLACE` должен дать audio
ошибку code=7 и сохранить старый запуск; с `/REPLACE` — новый play_id того же
объекта. STOP снимает playback pin и сохраняет READY object. Повторный PLAY после
STOP работает без перезагрузки файла; только FREE удаляет объект.

Для отдельной проверки ESC запустите `UGPLAY FOUR.MOD /LOOP /WAIT`: ESC должен
остановить только этот экземпляр и оставить READY handle. ESC в UGMON должен
только закрыть монитор, звук продолжится. При `/F00:PAUSE` ожидается PAUSE (по умолчанию F00 игнорируется);
`UGPLAY RESUME` должен приниматься без повторного запуска файла.

Для независимых FX добавьте корректный mono WAV как `FX.WAV`, во время MOD
выполните `UGLOAD FX.WAV /TYPE:WAV /VERIFY`, затем четыре раза
`UGPLAY FXHANDLE <wav-handle> /LOOP`. Должны быть заняты lanes8…11; MOD продолжает
играть. Пятый запуск — NO_VOICE без изменения музыки/четырёх FX.
`UGPLAY FXSTOP ALL` останавливает FX; `UGPLAY STOP` останавливает MOD.
Проверьте `UGDUMP <mod-handle> BACK.MOD /VERIFY` при звучащем MOD: bytes должны
совпадать с оригиналом, звук не должен повреждаться.

Сохраните вывод сессии, hashes UF2/EXE, модель платы/PSRAM, слот и аудиозапись.
Ожидаются нулевые underruns/ошибки PSRAM. Измерения LRCLK=48000 Гц, непрерывности
I2S, render/bus budgets и прослушивание на реальном стенде остаются REAL_PENDING.
`UGPLAY /GS`, `UGTEST GS/MOD4`, legacy PROPLAY/aliases/LOAD/D2/FX/6A/6B пока не
входят в доступный функционал этой сборки. Нельзя отмечать S7 выполненным по
этому native smoke-тесту.
