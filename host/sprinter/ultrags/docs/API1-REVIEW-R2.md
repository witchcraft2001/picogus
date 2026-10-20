# Повторное ревью VLS1 — 2026-10-20

Проверены изменения относительно `c711958`, текущий wire contract и решение
владельца в `ultra-gs-docs/ultra-gs.md`. Прежний отчёт
[API1-REVIEW.md](API1-REVIEW.md) описывает первую VLS1-поставку.

## Найдено и исправлено

| Замечание | Исправление и проверка |
|---|---|
| P1: ошибка flush из LEGACY_INFO/WRITE_BEGIN не сохранялась в LOAD; D2 мог опубликовать усечённый READY | `legacy_flush` сохраняет terminal error; D2 возвращает E1 и освобождает pending объект, ранее готовые FX сохраняются |
| P1: неуспешный BULK commit помечал объект ERROR, но D2 мог заменить это состояние на READY | GS DATA отбрасывается после такого отказа; D2 проверяет ERROR до flush/CRC и не публикует успешный prefix |
| P2: UGMON принимал укороченные VOICE_STATUS/FX_STATUS с корректным CRC | Total сверяется с CAPS либо с held SNAPSHOT; три actual-EXE регрессии: пустая/половинная таблица голосов и усечённая таблица FX |
| P2: HASHES.TXT в плоском каталоге ссылался на отсутствующий UGHOST.IMG | Отдельные списки хешей для плоского каталога и DSS-архива; имена и содержимое проверяются независимо |
| P2: frozen verifier не проверял сохранённые evidence-файлы | Проверяются их SHA-256, связь assembly/execution с proof, полный список исполненных EXE и результаты общего прогона |
| P2: staged-исходники могли получить build ID без dirty marker | `git status --porcelain` учитывает staged, unstaged и untracked файлы |
| P2: UG_LANES=064 мог пройти decimal-проверку CMake и превратиться в octal 52 при C-компиляции | Запрещены ведущие нули; configure с 064 завершается явной ошибкой |

Обновление SET_MIX согласовано с `music_lane()` для скрытых MOD-голосов под GS FX.
Это устранение внутренней несогласованности; следующий `mod_sync` обычно уже
маскировал её, поэтому отдельный слышимый сбой для этого пункта не заявляется.
Регрессия проверяет music mute при продолжающемся GS FX и тишину после его STOP.
UGMON также читает channels как u16.

На предыдущем коде воспроизведены ошибочное подтверждение LOAD после отказа
PSRAM, принятие трёх усечённых таблиц и ссылка checksum на отсутствующий IMG.
Логи воспроизведения находятся в `build/review-probes/`; это отрицательные
контроли, они не используются как успешная приёмка исправленной сборки.

## Соответствие плану

| Пункт | Статус |
|---|---|
| ARM polling/handlers и реальные generated PIO; STATUS/INFO без CRC в read path | Реализовано; прошивочный gate повторно пройден |
| Раннее распознавание BASE/ALIAS/точных B3/BB, passivity, map-before-ACK, IOW/IOR, DACK/ADS и независимый fuse | Реализовано; generated-instruction и production-C guard проверки |
| Расширяемый общий пул, u16 IDs, CAPS и coherent held pages | Реализовано; production 32, 64 в функциональных проверках |
| GS LOAD/dispatcher, неизменённый PROPLAY, понятный UGCFG, CRC combine в UGDUMP | Реализовано; targeted регрессии и общий actual-EXE прогон |
| Два независимых комплекта, hashes и executed EXE == ZIP/IMG | Повторно собрано, исполнено, упаковано и проверено |
| Полный physical render budget, SRAM/I2S/PSRAM contention и zero underruns | REAL_PENDING; инструкция ARM не равна измерению времени полного кванта |
| Функциональный прогон GUS → ULTRAGS → INFO/VERIFY → память → SAVE → power cycle → ULTRAGS → GUS | REAL_PENDING для исправленной прошивки |
| Полный GS/MOD effect audio conformance | Не закрыт текущими функциональными моделями |

Полностью закрытым этап считать нельзя. S6/S7 остаются IN_PROGRESS;
аппаратная приёмка и указанные conformance gates не подменяются числом тестов.
S3M/XM/IT и отдельные MOD8/playlist работы не объявляются реализованными.

## Итог проверки и поставка

Оба независимых комплекта: 1918 общих actual-EXE PASS, 43 исполненных EXE;
198 EXE/production-C сценариев, включая неизменённый PROPLAY slots0/1 ×
Turbo ON/OFF с точным ATDT.MOD readback. MOD4:82 EXE/66 C-model, context238,
Turbo47, malformed held pages3, wire/protocol10 — PASS. C/UBSan включает
ошибки flush, BULK commit → немедленный D2 и BULK commit → SD → D2;
оставшийся FX сохраняется, pending handle/pin не утечёт. Renderer1890 cases,
golden samples, shared voices32/64 и production-C guard — PASS.

Повторены linked ARM10 profiles, generated PIO512 maps/1048576 addresses и
288 INFO+CRC frames, IOW/IOR phases, PSRAM ID, fuse и SAVE clock. Все шесть
прочих mode images идентичны эталону кроме объявленной SDK даты. Settings
v6=156/offset152. Main SRAM free97196; static parser1408/render1336 из2048.
Timing и физические аудиопроверки остаются открытыми.

Поставка опубликована через постоянный `build/latest/`. Все 9 пользовательских
EXE совпадают с исполненными и извлечёнными ZIP/IMG; два полных набора идентичны.
Проверены 17 файлов и 54 evidence-файла; 71 подмена отвергнута.
Прежняя опубликованная поставка сохранена без изменений.

| Файл | SHA-256 |
|---|---|
| PGMULTI.UF2 | `51a6c3bdf4b3e0d18c115ba8bf36a53e7f8ef7c88df6cae31bce20088ec66bb3` |
| ug-full.zip | `7ad9ae537337aa5d439b054d9a876f074a6adbe7cfb24d2934b20bffeb1963b8` |
| ug-host.zip | `60609fa0c45a6e160d490ddf1bdb7736fb812d916748f0fe3c3dacdb3134681d` |
| ug-host.img | `1af12dad8929473b93ed6a1eb89fc8fc07ae58ffb370612da19041ebe91f89da` |

Нужны исправленная UF2 и EXE из этого комплекта совместно. Tester Notes —
[API1-VOICES.md](API1-VOICES.md), также TESTER.TXT внутри архива.
Build ID по контракту содержит git revision и dirty marker; разные dirty
сборки различаются по SHA-256 UF2 и каталогу из UGCFG INFO /DIAG.
