# ULTRAGS VLS1: реализация и программная проверка

Исторический отчёт первой VLS1-поставки. Замечания повторного ревью и текущий
результат — [API1-REVIEW-R2.md](API1-REVIEW-R2.md).

Дата отчёта: 2026-10-20. Поставка: `build/latest/`.
Статус: **SOFTWARE_PASS / REAL_PENDING**, S7 — **IN_PROGRESS**.

## Изменения

- Общий пул 32 физических голосов music/FX. Параметр `UG_LANES`, u16 ID,
  атомарное выделение стерео, резервирование pending/paused голосов,
  вытеснение FX целиком. Native API больше не использует voice masks.
- Исходный API 1.0 VLS1: INFO40, CAPS44, SNAPSHOT64 и удерживаемые страницы
  VOICE_STATUS/FX_STATUS по ключу session+snapshot_seq. Старый draft layout
  отвергается до изменения объектов. Исторические GS masks сохранены.
- Общая программа PIO0 на 32 инструкции для IOR/IOW: раннее распознавание
  BASE/ALIAS и точных GS-портов B3/BB, ожидание до захвата данных, сохранение
  DACK/ADS и освобождения драйвера. Timer2/core1 отключает шину при зависании
  core0. Другие режимы используют прежние ISA-программы.
- GS NORMAL/POST/RESPONSE/LOAD, musical dispatcher, private legacy handles,
  LOAD через GS_DATA и BULK с порционной фиксацией/CRC, D2 и безопасный reset.
  Неизменённый PROPLAY выполняется через функциональные DSS/BIOS модели.
- Понятная справка UGCFG и `UGCFG ULTRAGS /GSALIAS ON [/SAVE]`.
  GSALIAS остаётся volatile. SAVE выполняется только после успешной проверки.
- UGDUMP `/VERIFY` объединяет CRC уже проверенных блоков без повторного
  прохода по payload; печатает время и скорость. Файловые пути сохраняют cap256,
  а Turbo всех обычных ISA-окон — `2 → ISA → 3`.
- Ускорен renderer с точным сохранением округления, интерполяции и pan;
  стерео использует общий кэш, рабочие массивы вынесены со стека.

При ревью дополнительно исправлены восстановление скрытого MOD-голоса после
STOP/free, сохранение играющего GS FX при остановке MOD, копирование лишнего
байта SET_TEMPO, AUDIO status, preferred stereo allocation, legacy selection
и finetune, игнорирование обычных SC-команд в LOAD, same-mode reboot во время
старого INFO. Тесты больше не принимают старую сборку после ошибки assembler.

## Выполненные проверки

Оба независимых каталога `build/voices-a` и `build/voices-b`:

| Проверка | Результат каждого комплекта |
|---|---|
| Общий actual-EXE suite | 1918 PASS, 0 FAIL; все 43 EXE исполнены |
| S2 / S3 / S4 / S5 / S6 | 270 / 109 / 193 / 515 / 349 сценариев PASS |
| EXE против production C | 198 сценариев PASS |
| Неизменённый PROPLAY + ATDT.MOD | slots 0/1 × Turbo ON/OFF; точный native readback и CRC |
| MOD4 actual EXE | 82 PASS + 66 общих C/model vectors |
| Конфигурация и контекст | 238 PASS; PAGE3/IFF/SP/Turbo, DSS register clobber |
| Turbo contract | 47 PASS; SNAPSHOT64 читается однократно за 8 окон |
| Wire/schema/protocol | 10 PASS, 0 FAIL |
| C renderer / UBSan | 1890 точных scalar cases, 4590084 golden samples, большие offsets/EOF/faults |
| Общий пул | 32/64, IDs выше 31, stereo/pause/pending/steal/pages/ID wrap |
| Generated PIO | 512 maps; 1048576 read/write addresses; 288 полных INFO+CRC кадров |
| IOW/IOR и fuse | 12 фаз, 524288 записей, DACK/ADS/full RX, stopped core0/timer wrap |
| Linked ARM renderer | 10 профилей; точное совпадение независимого oracle |
| ZIP/IMG | Два идентичных комплекта; извлечённые EXE совпадают с исполненными |
| Подмена | 17 изменённых файлов отвергнуты проверкой frozen delivery |

Старый поздний ответ воспроизведён: хост видит FF, consuming index продвигается
один раз. Новый PIO при той же абсолютной модельной задержке отдаёт полный INFO
с CRC. Учитывается разная частота старого и нового PIO.

Все шесть прежних mode images совпали с эталоном, кроме объявленной SDK даты
сборки. Мутации кода в этом сравнении отвергаются. Settings v6: 156 bytes,
UltraGS offset152. В production профиле свободно 98012 bytes main SRAM;
static render chain с резервом — 1336/2048, parser — 1408/2048 bytes.
Отдельно собраны NE2K, ULTRAGS debug и ARM-профиль с 64 голосами; последний
не является поставляемым аудиопрофилем и не прошёл аппаратную приёмку.

## Воспроизведение

```sh
# SDK/toolchain — согласно AGENTS.md; private inputs не включены в поставку.
UG_PROPLAY=/path/PROPLAY.EXE UG_PROPLAY_MOD=/path/atdt.mod \
  make -f Makefile.ultrags voices-host BUILD=build/voices-a
UG_PROPLAY=/path/PROPLAY.EXE UG_PROPLAY_MOD=/path/atdt.mod \
  make -f Makefile.ultrags voices-host BUILD=build/voices-b
python3 tools/ultrags/voices-firmware.py --build build/voices-a
python3 tools/ultrags/voices-firmware.py --build build/voices-b
node tools/ultrags/verify-voices.mjs build/latest --mutations
```

Прошивочные проверки требуют свежих отчётов compare-firmware-paths, pio-isa,
psram-id, handshake-guard, save-clock, audio-render, voices-budgets и s7-stack.
Команды и hashes входов/артефактов сохранены в `DELIVERY.json` и `evidence/A,B`.
Прежние опубликованные комплекты не изменялись.

## Границы результата

Счётчик инструкций ARM и модели PIO/PSRAM/DSS не доказывают физический бюджет
2 ms, арбитраж SRAM, setup/hold ISA или отсутствие underruns на карте.
PIO сериализует транзакции; не заявляется обслуживание произвольного
неограниченного потока чужих циклов при остановленном ARM. Нужен функциональный
прогон с I2S/PSRAM и другой ISA-картой на непересекающихся адресах.

Скорость новой прошивки на Sprinter ещё не измерена. Текущие форматы —
RAW/WAV/MOD4; S3M/XM/IT/MOD8/playlist и полный GS/effect audio conformance
остаются отдельными работами. После аппаратного прогона обновляются REAL gates;
до него S7 остаётся IN_PROGRESS. Команды для владельца —
[API1-VOICES.md](API1-VOICES.md), также `TESTER.TXT` внутри `ug-full.zip`.

## Идентичность поставки

| Файл | SHA-256 |
|---|---|
| PGMULTI.UF2 | `f1bd86320e2e1ce2642d1a2ac18ee9145f481c5926288f1d1371cd181f1d203e` |
| ug-full.zip | `7f25017e75abfc24d1c4c7dc05d9afe3ed9f472b7d7b52fa46d407533b80fc58` |
| ug-host.zip | `741783cb5391fcf412ca1f5aef2291000a193b3390fe7bca2778aabfe57c2762` |
| ug-host.img | `e1458f25a97badd75f7112fde7115d8d4b87ebfdf97bbf8207888d5abcf6566f` |
