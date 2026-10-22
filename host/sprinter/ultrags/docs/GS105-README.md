# GS 1.05 / UGS-GS105/1

Обновление S8b: владелец подтвердил UGGSC, UGGST и PROPLAY при Turbo ON на R17. Исторические отказы ниже сохранены; полные физические gates остаются открыты. FLT8 описан в S8B-README.md.

Для нового кандидата R17 (GS в Turbo) сначала читать `GS-TURBO-README.md`. Ниже описана принятая ранее серия GS105 при Turbo OFF и её
регрессионные проверки; утверждение «прошивка не меняется» относится к тому
исправлению DSS RAM, а не к новой поставке GS Turbo.

Исправление DSS RAM: прежний UGTEST MOD4/MOD8 размещал fixture по3000h,
в resident DSS. Владелец подтвердил зависание после RESULT PASS code=0
при Turbo OFF. Новый fixture —4000h; UGPLAY FX/stream table также перенесён
из resident RAM в4000h, count и saved IDs разнесены. Прошивка не меняется;
заменить EXE из свежего комплекта. Проверка на Sprinter: холодный перезапуск,
Turbo OFF → UGTEST MOD4 → RESULT PASS code=0 → приглашение DSS → UGMEM INFO.
HOST проверяет неизменность0100..3FFF, включая записи DSS READ; низкие векторы
0000..00FF остаются отдельной областью NMI selftests.
Владелец после исправления сообщил «тесты пройдены Pass», включая контекст
ATDT /GS /SLOW /VERIFY /REPLACE. Это REAL_PASS сообщённой серии; полного
вывода, slot/длительности и отдельной записи возврата MOD4 в DSS нет.
Длительные прогоны, оба слота и timing gates остаются REAL_PENDING.

Software: HOST_PASS / DSS_EXE_PASS после выполнения `gs105-check` и полной
регрессии поставки. S7 IN_PROGRESS / REAL_PENDING. Проверять Sprinter с аппаратно
отключённым Turbo. Известный отказ GS STATUS при Turbo ON сохраняется; исправление
Turbo ON — следующий этап, FLT8 — после него. Оптимизация streaming отложена;
подтверждённые S8c REAL_FAIL и цели 176400/220500 Б/с сохраняются.

Установить `build/CURRENT.UF2` обычным способом, взять EXE из согласованного
`CURRENT.ZIP` либо `CURRENT.IMG`. UF2/IMG не входят в ZIP. Хеши и фактические результаты:
`build/GS105-CONFORMANCE.md`, `build/GS105-CONFORMANCE.json`, `build/DELIVERY.json`.
Низкие aliases для этих команд не нужны и автоматически не включаются.

```
UGCFG ULTRAGS
UGMEM INFO
UGTEST MOD4
UGTEST GS
UGMEM INFO
UGPLAY FOUR.MOD /GS /VERIFY
UGMON /GS /COUNT:3
UGPLAY PAUSE
UGPLAY RESUME
UGPLAY STOP
UGPLAY FOUR.MOD /GS /SLOW /VERIFY /REPLACE
```

Ожидания:

- `UGTEST MOD4` проверяет собственный M.K. fixture, естественный порядок первых
  четырёх каналов, dirty flags, manual tick и независимость GS FX/PCM foreground.
- `UGTEST GS` дополнительно печатает отдельные STATUS_7E, SIGN_ROM, FINETUNE,
  POST_D0_ABORT, REINIT_FREES_FX, LOAD_IGNORE, EXT_DURING_LOAD,
  LOAD_PAUSE_120S, CHANNEL_ORDER, BUSY_MANUAL, LEGACY_FX_PCM_STATE и PASS после
  каждой выполненной проверки. LOAD_PAUSE_120S действительно ждёт не менее
  120 секунд. Во время ожидания можно нажать ESC. Отсутствие движения часов —
  ошибка с конечным watchdog, не успешная 120-секундная проверка.
- Оба теста требуют пустого store и отсутствия воспроизведения. Без `/RESET`
  возвращают BUSY, сохраняя чужие объекты/foreground. `UGTEST GS /RESET` или
  `UGTEST MOD4 /RESET` явно разрешает уничтожение всех объектов с предупреждением.
  При нормальном завершении/ESC и ошибке ACK PLAY_PCM собственный foreground
  определяется по session/object и останавливается; тестовые assets освобождаются;
  итоговый UGMEM INFO должен показывать objects=0 и полный свободный пул.
- `UGPLAY file.MOD /GS` поддерживает M.K., M!K!, 8CHN через исторические
  30/D1/payload/D2/31. FAST использует BULK-мост, `/SLOW` — SD/WD. `/VERIFY`
  сравнивает CRC и каждый байт полного readback после D2. SEAL pending не применяется.
- Перед PLAY повторно проверяются session и выбранный legacy handle.
  `GS_MODULE_CHANGED_NOT_STARTED` означает, что выбранный модуль заменён;
  команда PLAY не отправлена. GS PLAY исторически повторяет MOD; `/LOOP` подтверждает этот режим. F00
  наследуется от GS 6A. `/GS /F00:IGNORE` и `/GS /F00:PAUSE` дают SYNTAX.
  Обычный native UGPLAY продолжает выбирать IGNORE по умолчанию.
- При existing legacy assets нужен `/REPLACE`: предупреждение сообщает, что
  команда 30 освобождает все legacy MOD/FX. Независимые EXT assets сохраняются.
  `/GS` с HANDLE/PCM/STREAM/FX или управляющими командами даёт SYNTAX.
- `/WAIT` следит за экземпляром до ESC, замещения или ошибки. ESC останавливает
  только свой экземпляр. STOP/PAUSE/RESUME без `/GS` управляют и GS foreground.
- При `GS_D2_OR_PLAY_RESULT_UNKNOWN_NOT_RETRIED` запуск не повторяется. Автоматических
  F3/F4 нет. Проверьте UGMEM INFO/LIST и UGMON; неизвестный PLAY может уже играть.
  Подтверждённый pending очищается через D2 и FREE только своего handle; при
  неопределённом PLAY опубликованный asset сохраняется для диагностики.
- `UGMON /GS` читает 60..64 последовательно; это не атомарный снимок. 63/64
  возвращают MOD 0,1,2,3, bit7=unchanged, и очищают только свои dirty flags.
  При известном pending LOAD печатает `GS LOAD active`, не посылает 60..64
  и сохраняет загрузку. Монитор не приостанавливает музыку. Native SNAPSHOT
  dirty flags не очищает.

Для исходных треков повторить FAST и SLOW с /VERIFY (никаких правок файлов):

```
UGPLAY ATDT.MOD /GS /VERIFY /REPLACE
UGMON /GS /COUNT:5
UGPLAY STOP
UGPLAY ATDT.MOD /GS /SLOW /VERIFY /REPLACE
UGPLAY BST.MOD /GS /VERIFY /REPLACE
```

ATDT SHA256: a91378987b0c7f64676302645a9e7f1d5cb7fbf6398ad4d0a0f8e03ba27675f2.
BST — исходный bruno_-_bst.mod, SHA256:
024f4b4a2c4ab31524243dfaa389b7dd38b3af4d2cdd37d6cbf6efab03d70a8a.
Они не распространяются в комплекте. При 6A=0 BST намеренно приостанавливается
на F00, order4/pattern3/row55 (~19.04s); это ожидаемая политика GS. Native
`UGPLAY BST.MOD` игнорирует F00 и заканчивает файл примерно через151.14s;
`UGPLAY BST.MOD /F00:PAUSE` сохраняет паузу. Проверить прослушивание и readback,
зафиксировать hashes UF2/EXE, слот, Turbo OFF и длительность. HOST-модель
не измеряет ISA/PIO/IOCHRDY или render deadlines на карте.

Воспроизведение программных проверок (sjasmplus1.22.0, Node, C compiler, Python):

```
export UG_PROPLAY=/path/to/original/PROPLAY.EXE
export UG_PROPLAY_MOD=/path/to/original/atdt.mod
export UG_F00_MOD=/path/to/original/bruno_-_bst.mod
make -f Makefile.ultrags gs105-check
```

Для отсутствующего reference cache (содержимое затем проверяет runner):

```
mkdir -p build/reference/micromod
curl -fsSL https://raw.githubusercontent.com/martincameron/micromod/83b5d9aebddb528ea177e115b0afed5d75f6b92a/micromod-c/micromod.c -o build/reference/micromod/micromod.c
curl -fsSL https://raw.githubusercontent.com/martincameron/micromod/83b5d9aebddb528ea177e115b0afed5d75f6b92a/micromod-c/micromod.h -o build/reference/micromod/micromod.h
```

Независимый Micromod83b5d9aebddb528ea177e115b0afed5d75f6b92a хранится в
`build/reference/micromod/{micromod.c,micromod.h}`; runner проверяет закреплённые
SHA256 и не меняет эталоны. Это тестовый reference, в прошивку он не линкуется.
Зафиксированные различия: native priority верхнего nibble Axy, безопасный clamp
периодов, E3/E5, фаза modulation, F00-политика. Полный список и traces — conformance
report. Исключения проверяют только конкретные поля и значения; искажение
темпа отклоняется для каждого профиля. Проверяются 77 tick fixtures (75 фиксированных, 2 проверки границ и знакопеременной
нерегулярности random waveform), включая
обе части 5xx/6xx, waveform/phase, global last-wins и 9FF без петли. FX сравнивается с отдельным математическим oracle: все96 нот и7 граничных
fine values для S8/U8, короткая петля, абсолютные уровни stereo/sum, все direct family команды,
смена pitch/gain без сброса фазы и продолжение при MOD PAUSE/STOP/EOF; допуск96/32768 за1024 frames
покрывает опубликованное Q16/Q32 приближение. Native/GS MOD audio сравнивается точно.

REAL_PENDING не отменяется HOST_PASS. Для аппаратной приёмки нужны оба слота,
реальные120с LOAD, прослушивание MOD/FX, pause/stop/EOF и длительные прогоны S7/S8a.

Упаковка `node tools/ultrags/package-gs105.mjs` требует свежие доказательства
GS/native/S7/S8a/F00, linked ARM и общую регрессию. Файлы перечислены явно,
предыдущий CURRENT.ZIP не используется. Каждая сборка имеет собственные EXE,
fixtures, HASHES.TXT, ZIP и FAT12; их байты должны совпасть. Проверка:

```
python3 tests/ultrags/unit/test_gs105_evidence.py --build build
node tools/ultrags/package-gs105.mjs --verify-only
```

Mutation-проверки требуют отказа при устаревшем адаптере/EXE, отсутствии
GS race/S7 evidence и ошибке S7; прежний PASS-отчёт при отказе удаляется.
