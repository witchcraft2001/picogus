S3M PCM is available through native PLAY_MOD and GS30/31. `.S3M` and `/TYPE:S3M` are accepted; CAPS.formats bit7, kind5. Mono uses one voice per enabled channel; stereo can require two. See [S3M tester notes](docs/S3M-README.md) and [programmer guide §6.5](docs/ULTRAGS-PROGRAMMING.md). HOST_PASS / REAL_PENDING; previous hardware failures remain open.

AdLib OPL2 is always available in UltraGS at `0388h/0389h`; `CAPS.features` bit13. `UGOPL TEST` and `UGOPL MIX /FX:MONO|STEREO` exercise FM alongside MOD8/FX. Physical acceptance is REAL_PENDING; [AdLib tester notes](docs/ADLIB-README.md). S8c REAL_FAIL remains open.

DOPE audio fix: MOD5..8/9..16/17..32 now use /2,/4,/8 headroom before pan; full DOPE has0 digital clips. Previous owner grating report is REAL_FAIL; corrected firmware awaits physical retest.

FLT4 PCM and interleaved MOD1..32 (including 28CH DOPE.MOD) are supported; shared pool32, formats bit6. Physical acceptance remains REAL_PENDING. See docs/S8B-README.md.

S8b: PCM FLT8, UGTEST FLT8 and CAPS.formats bit5 are implemented; physical acceptance remains REAL_PENDING. See docs/S8B-README.md.

MOD F00 (2026-10-21): UGPLAY/UGPF default to IGNORE; `/F00:PAUSE` is explicit.
New firmware capability bit12 required; [Tester Notes](docs/F00-README.md).
HOST_PASS / REAL_PENDING; current kit: `build/CURRENT.*`.

S8a (2026-10-21): MOD8/8CHN, independent FX and background storage are implemented.
HOST_PASS / REAL_PENDING; new firmware required. [Tester Notes](docs/S8A-README.md).
Current kit: build/CURRENT.ZIP, build/CURRENT.UF2, build/CURRENT.IMG.
S8c streaming optimization is deferred; confirmed 44100/S16/stereo REAL_FAIL remains open.

# Утилиты ULTRAGS для Sprinter

[Руководство программиста UltraGS](docs/ULTRAGS-PROGRAMMING.md) - последовательное
обучение, справочник GS/native/OPL2 и собираемые примеры.
[PDF для чтения и печати](docs/ULTRAGS-PROGRAMMING.pdf) хранится в репозитории.
`make -f Makefile.ultrags docs` пересобирает PDF и обновляет эту копию;
`docs-check` проверяет таблицы, листинги,
PDF и исполнение примеров в Z80/DSS-стенде. Зависимости и команды приведены ниже.

Сборка и готовый комплект всегда находятся в **`build/`** от корня репозитория.
`CURRENT.ZIP` содержит EXE, тестовый WAV и инструкции. Прошивка
`CURRENT.UF2` и образ `CURRENT.IMG` лежат отдельно и в ZIP не включаются.
`build/latest/` — совместимая ссылка на этот же каталог.
Обычные команды `make -f Makefile.ultrags ...` используют постоянный `build/`;
переопределение `BUILD` не меняет каталог. Проверка воспроизводимости может
использовать фиксированный подкаталог `build/reproducibility/`.

Текущий контракт — исходный API 1.0 **VLS1**, общий пул 32 голосов.
При переходе нужны новая прошивка и все EXE из одного комплекта.
Инструкция с командами и ожидаемыми результатами:
[S8C-README.md](docs/S8C-README.md), также `TESTER.TXT` внутри архива;
остальной API описан в [API1-VOICES.md](docs/API1-VOICES.md).
Хеши и результаты независимых сборок — `HASHES.TXT` и `DELIVERY.json`.

Короткий пример включения исторических GS-портов:

```text
UGCFG ULTRAGS /GSALIAS ON
PROPLAY ATDT.MOD
```

Явный `UGCFG SAVE` сохраняет режим старта, BASE и BULK alias.
GSALIAS действует до перезапуска карты и через SAVE не сохраняется.
SAVE записывает Flash; выполнять его после каждого запуска программы не нужно.

Функциональный прогон на реальном Sprinter остаётся `REAL_PENDING`;
S7 — `IN_PROGRESS`. Каталоги промежуточных сборок не являются поставкой.


## Руководство и учебные примеры

[ULTRAGS-PROGRAMMING.md](docs/ULTRAGS-PROGRAMMING.md) - единственный
редактируемый источник PDF. ReportLab читает этот Markdown. Таблицы форматов
синхронизируются со схемой, листинги - с ASM-исходниками; помеченные блоки
обновляются `python3 tools/ultrags/docs-sync.py`. Обычный текст редактируется
в Markdown. Сам PDF не редактируют.
Готовая копия `docs/ULTRAGS-PROGRAMMING.pdf` включена в Git по запросу владельца,
чтобы читателю не требовались инструменты сборки. При изменении руководства
пересоберите PDF и включите обе версии в один коммит. Сборка воспроизводима
при одинаковых исходниках, шрифтах и версиях инструментов: время запуска
не меняет содержимое PDF.

Нужны sjasmplus 1.22.0, Python 3, Node.js, C/C++ компилятор и заголовки Node
для стенда. Для PDF нужны пакеты из `tools/ultrags/requirements-docs.txt` и
Poppler (`pdftoppm`). По умолчанию используются Arial и Andale Mono из macOS.
На Linux задайте `UG_DOC_FONT`, `UG_DOC_BOLD`, `UG_DOC_MONO` путями к TTF
с кириллицей, например DejaVu Sans / Sans Bold / Sans Mono.
Из корня репозитория:

```sh
uv venv build/host/docs/venv
uv pip install --python build/host/docs/venv/bin/python -r tools/ultrags/requirements-docs.txt
make -f Makefile.ultrags docs
make -f Makefile.ultrags docs-check
```

`docs` создаёт `build/ULTRAGS-PROGRAMMING.pdf`, копирует его в
`host/sprinter/ultrags/docs/ULTRAGS-PROGRAMMING.pdf`, создаёт EXE и собственный GUIDE.WAV в
`build/host/docs/examples/`, а также отдельные `build/host/docs/EXAMPLES.ZIP`
и `EXAMPLES.IMG`. Прошивка и `CURRENT.*` этой целью не обновляются. `docs-check`
исполняет собранные EXE в Z80/DSS-стенде с C-кодом действующей прошивки,
проверяет оба слота, IFF/PAGE3/стек, выход и ошибки, таблицы, ссылки и листинги,
а также совпадение PDF в `build/` и в каталоге документации.
Хеши входных файлов, ревизия Git и результаты сохраняются в
`build/host/docs/check.json`; это позволяет различать и незакоммиченные редакции.
PNG всех страниц находятся в `build/host/docs/pages/`; после изменения
оформления их нужно просмотреть. Проверки на компьютере не заменяют
измерение ISA-обмена и прослушивание на реальном Sprinter.

### Собрать один пример

Базовые примеры требуют только sjasmplus и сгенерированного `ug_wire.inc`.
Для генерации используется Node.js; Python и ReportLab нужны только для
пакетной сборки документации. Из корня репозитория:

```sh
node tools/ultrags/gen-wire.mjs tools/ultrags/wire-schema.json build/ultrags/gen
mkdir -p build/host/docs/examples
sjasmplus --inc=host/sprinter/ultrags/include --inc=host/sprinter/ultrags/lib --inc=build/ultrags/gen -DDOC_SLOT=0 --raw=build/host/docs/examples/PCM0.EXE host/sprinter/ultrags/examples/firstpcm.asm
```

Для второго слота задайте `-DDOC_SLOT=1` и имя PCM1.EXE. Аналогично собирается
`examples/discover.asm`. Остальные входные файлы подключают полные DSS-приложения;
для них добавьте `--inc=host/sprinter/ultrags/apps` либо используйте `docs`.
Все примеры без выпуска PDF собирает `make -f Makefile.ultrags docs-examples`.

### Подготовить карту и запустить

Используйте прошивку UltraGS API1/VLS1 и совместимые утилиты. До запуска
примеров проверьте слот и режим. Следующие команды для слота 0:

```text
UGCFG INFO /SLOT:0
UGCFG ULTRAGS /SLOT:0
UGCFG INFO /DIAG /SLOT:0
DISCOV0
PCM0
```

Ожидаются BASE=02A0, API1/VLS1, boot_state=0. DISCOV0 печатает
`UltraGS API1/VLS1 ready`. PCM0 создаёт тихий тон 125 Гц примерно на 1-2 секунды,
проверяет чтение образцов и печатает `PCM: uploaded, read back, played, freed`.
Код выхода PCM0 - код ошибки API, 0 при успехе, 15h при ESC. Перед работой
программа сбрасывает карту (RESET_STORE уровня 0): всё загруженное раньше
удаляется, звук останавливается. Для слота 1 задайте
`/SLOT:1` в UGCFG и используйте DISCOV1/PCM1. Автопоиска слота нет.
GSALIAS для этих программ не нужен: они работают через BASE. Если BASE
другой, измените константу `CARD_IO_BASE` в firstpcm.asm (в discover.asm -
аргумент `LD HL` перед `UG_OPEN`) и пересоберите пример;
программа сама не меняет адреса карты.

BASE можно изменить без перепрошивки через `UGCFG PORTS`. Например, если
блок портов 02C0h..02DFh свободен, при остановленном воспроизведении и
завершённых передачах для слота 0:

```text
UGCFG PORTS 02C0 OFF /SLOT:0
UGCFG INFO /SLOT:0
UGCFG SAVE /SLOT:0
```

02C0 - новый BASE, OFF отключает дополнительный BULK alias. Изменение
вступает в силу сразу; SAVE сохраняет его после выключения питания.
Без SAVE оно временное. Ключ `/BASE:02C0` лишь задаёт адрес поиска для
утилиты; для перенастройки устройства нужна именно команда PORTS.

### Уроки и сопровождающие сценарии

Самостоятельные уроки собираются для каждого слота отдельно (суффикс 0 или 1)
и не принимают аргументов: `DISCOV0`, `PCM0`, `MODFX0`, `FM0`, `GSMOD0`,
`S3M0`, `GSS3M0`. Код выхода - код ошибки API (0 успех, 15h ESC).
Уроки с объектами начинают с тёплого сброса карты (RESET_STORE уровня 0) и
удаляют всё, что было загружено до них. MODFX и GSMOD содержат встроенный
`GUIDE.MOD`, который `docs-examples` собирает вместе с ними.

| Урок | Что делает | Ожидаемый вывод |
|---|---|---|
| `PCM0` | Свой массив отсчётов: ALLOC, UG_WRITE, PCM_CONFIG, SEAL, чтение обратно, PLAY_PCM, STOP, FREE | `PCM: uploaded, read back, played, freed` |
| `MODFX0` | MOD блоками по 1024 байта, PLAY_MOD с повтором, PLAY_FX поверх музыки, STOP_FX, FREE обоих объектов | `MODFX: music looped, effect added and stopped, freed` |
| `FM0` | Инструмент OPL2 на канале 0, нажатие и отпускание клавиши | `FM: note played and released` |
| `GSMOD0` | Тот же MOD командами GS: 30h, байты, D2h, 31h, 32h, 33h, 37h | `GSMOD: module loaded by GS commands, played, paused, resumed, freed` |

Три входных файла переиспользуют полноценные приложения проекта и принимают
их командную строку; это расширенные проверки, а не учебные программы:

| Команда | Что проверяет | Ожидаемый результат |
|---|---|---|
| `GSFX GS /SLOT:0` | S8/U8, параметры FX и поведение GS в LOAD | PASS; включает паузу LOAD более 120 секунд |
| `PCM PCM /VERIFY /SLOT:0` | RAW, SEAL, чтение обратно, пауза и продолжение | PASS, свои объекты удалены |
| `STREAM STREAM GUIDE.WAV /BUFFER:16 /PREFILL:8 /LOW:4 /SLOT:0` | DSS WAV, кольцо, FEED, EOF, закрытие | EOF и PASS; underruns и звук проверять отдельно |

Замените `/SLOT:0` на `/SLOT:1` для другого слота. Не задавайте `/RESET`:
сценарии должны отказываться от работы при несовместимых занятых ресурсах.
GS-тест проверяет также отказ RESET_STORE=BUSY внутри LOAD; этот сброс не
исполняется и не используется для очистки. Сценарии на UGTEST/UGPLAY
возвращают коды выхода утилит (например, 10 для ESC), отличные от кодов API
в самостоятельных уроках.

Исходные GS/NeoGS-руководства и их хеши сохранены в
`build/host/docs/sources/`; для повторной сборки PDF сеть не нужна.

S3M checks: `make -f Makefile.ultrags s3m-check`, repeat with
`REPRODUCIBILITY=1`, then `s3m-package`. Use the same SDK/compiler and private
MOD/PROPLAY regression inputs as `adlib-check`; set UG_AUDIO_PYTHON to Python
with Unicorn 2.1.4. Host S3M reference requires libxmp 4.7.0 (Homebrew include/lib
paths in s3m-host.py). Reports and original fixtures: build/host/s3m/.
`UG_S3M_BASELINE` defaults to `build/archive/pre-s3m/CURRENT.UF2`; the six
other firmware modes must match that archived delivery (apart from the SDK
build date). The inherited GS105 tests require `UG_PROPLAY_MOD=atdt.mod`
and `UG_F00_MOD=bruno_-_bst.mod`, with their original contents.
`docs-examples` builds S3M0/S3M1 and GSS3M0/GSS3M1; these standalone examples
require an empty store, monitor snapshots and clean up their own object.
