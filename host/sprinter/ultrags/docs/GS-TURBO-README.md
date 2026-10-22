# GS Turbo R17 — Tester Notes

Кандидат: `pg-ultrags-gsturbo-r17 v4.1.1`, файл `build/CURRENT.UF2`
(SHA-256 `cdf83d0e0085d2e98ec462ac60323ac16ade964bcf53167a2f13bc18d166d755`;
`build/multifw-release` и `build/reproducibility` побайтно совпали). Статус: **HOST_PASS / REAL_PENDING**.
Утилиты DSS не менялись: UGGST0/UGGST1, UGGSC0/UGGSC1, UGCFG, UGMEM берутся из
текущего `build/ultrags/dss` (`build/CURRENT.ZIP`/`CURRENT.IMG`).

## Что исправлено и почему

Стабильная R13 (`gsfast-r13`, профиль COMPAT) держит IOCHRDY в PIO только для
блоков BASE/ALIAS. Порты GS `00B3h/00BBh` шли «чужим» путём: PIO публиковал
адрес и ждал решения ARM, IOCHRDY опускался через ~150–250 нс после `/IOR↓`.
Sprinter в Turbo перестаёт опрашивать IOCHRDY примерно через 105 нс после
`/IOR↓` (`ISA_IOCHRDY_WAIT.md`), поэтому в Turbo чтение GS давало FF, а BASE —
работал. Это не ограничение железа карты: PIO успевает за ~30 нс.

R17 добавляет в `ug_compat_ior.pio` третий блок сравнения: при GSALIAS ON
A9..A5 = `05h` (`00A0h..00BFh`) обрабатывается как собственный блок и
IOCHRDY утверждается сразу при классификации, как для BASE/ALIAS. При GSALIAS
OFF слово сравнения патчится в `JMP foreign`, и блок остаётся пассивным.
Чтобы уложиться в 22 слова: убран ускоритель `JMP PIN` по A9 (CONFIG
захватывается на один такт PIO позже эталона R9, момент программного
удержания не изменился), все вердикты чтения стали адресами `OUT PC`
(`IO_WAIT` → вход `value`, `IO_END` → `restart`), снят `IRQ 0` — предохранитель
core1 считает ответы/освобождения на core0. ARM-обработчики каталога (cfgfast),
STATUS (gsfast), native и записи не менялись; IOW10 прежний.

R14–R16 (общий SHARED-классификатор с очередями/заморозкой SM в
`ug_handshake.c`) отменены: они меняли путь CONFIG и дали REAL_FAIL при
переходе в ULTRAGS. Их незакоммиченный патч сохранён в
`build/gs-turbo-r16-staged/` для истории.

Побочный эффект, принятый осознанно: при GSALIAS ON чтение любого другого
порта `00A0h..00BFh` растягивается до решения ARM (~100–200 нс) и
отпускается без данных. На Sprinter в этом диапазоне других устройств нет.

## Ожидаемое поведение

| Режим | BASE/ALIAS | GS `00B3/00BB`, GSALIAS ON | GS, GSALIAS OFF | CONFIG `1D0..1D2` |
|---|---|---|---|---|
| Turbo OFF | работает (как R13) | работает | пассивны (FF) | работает |
| Turbo ON | работает (как R13) | **работает (новое)** | пассивны (FF) | только Turbo OFF (UG*.EXE делают это сами) |

Записи в Turbo захватываются тем же IOW10, что и для BASE: запас по данным
такой же, как у BASE, который на стенде уже подтверждён.

## Проверка на Sprinter

Прошить `CURRENT.UF2` при выключенном Sprinter. Слот 0 (для слота 1 —
`/SLOT:1` и UGGSC1/UGGST1).

1. Аппаратный Turbo OFF — контроль, что ничего не сломано:

```text
UGCFG GUS
UGCFG ULTRAGS
UGCFG INFO /DIAG
UGMEM INFO
```

Ожидаются `firmware=pg-ultrags-gsturbo-r17`, каталог/CRC без ошибок, READY.

2. Аппаратный Turbo ON — переход, на котором отказал R14:

```text
UGCFG GUS
UGCFG ULTRAGS
UGCFG INFO /DIAG
UGCFG GSALIAS ON
UGGSC0
UGGST0
UGMEM INFO
```

UGGSC0: все 16 строк `SLOW1=7E FAST=7E SLOW2=7E`. UGGST0 обращается к
`00B3/00BB` при программном Turbo ON; нужны `RESULT PASS code=0`, возврат в
DSS и `objects=0` в UGMEM INFO.

3. Оригинальное GS-ПО при штатном Turbo ON DSS:

```text
PROPLAY C:\MEDIA\MODS\ATDT.MOD
```

Зафиксировать обнаружение GS, загрузку и слышимое воспроизведение.

4. Повторить п. 2–3 с аппаратным Turbo OFF и для второго слота. Сохранить
полный вывод, положение Turbo, слот и hashes.

При любом FF/TIMEOUT остановиться и сфотографировать экран; откат — R13
(`build/gs-turbo-baseline/build/CURRENT.*`).

## Программные проверки R17

- `tools/ultrags/compat-check.py`: 524288 адресов × GSALIAS ON/OFF, точное
  владение, 1280 байтов CONFIG/GS; отрицательный контроль: эталон R9 теряет
  чтение `00BB` при задержке ARM, R17 держит WAIT с момента классификации;
  пересечение IOW/IOR, production guard на core1 (новый счётчик завершений).
- `tools/ultrags/compat-independent.cjs` (rp2040js): 12288 захватов/ответов,
  три смещения программы, GSALIAS ON/OFF, выдача и освобождение шины.
- `tools/ultrags/config-exchange.py --compat --fast --gs-fast`: production
  ARM-обработчики, 213 операций, мутации отвергнуты.
- `tools/ultrags/compat-linked.py`: две независимые сборки, слова PIO в ELF
  совпадают со свежим pioasm, guard в SRAM, identity.
- `tests/ultrags/dss/run-gs-turbo.mjs`: реальные UGGST EXE против модели карты.
- Цель `make -f Makefile.ultrags gs-turbo-check` обновлена под COMPAT.

Ни одна из проверок не измеряет наносекунды Sprinter; Turbo ON подтверждает
только стенд.
