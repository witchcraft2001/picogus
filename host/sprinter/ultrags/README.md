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

GSALIAS действует до перезагрузки карты. `SAVE` сохраняет режим старта,
BASE и BULK alias; GSALIAS в Settings не входит.

Функциональный прогон на реальном Sprinter остаётся `REAL_PENDING`;
S7 — `IN_PROGRESS`. Каталоги промежуточных сборок не являются поставкой.
