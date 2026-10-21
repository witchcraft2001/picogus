# MOD F00: HOST_PASS / REAL_PENDING

UGPLAY и UGPF теперь продолжают MOD4/MOD8 после F00 по умолчанию.
`/F00:IGNORE` задаёт это явно; `/F00:PAUSE` включает паузу. Регистр букв
не учитывается. При старой прошивке выводится
`MOD_F00_POLICY_REQUIRES_NEW_FIRMWARE`: установите CURRENT.UF2 и EXE
из одного комплекта. Утилиты не меняют GS6A.

Опция применима только к запуску MOD по файлу или HANDLE. Повтор опции,
неизвестное значение, RAW/WAV, STREAM, FX и управляющие команды с `/F00:`
отвергаются. При запуске выводится `MOD F00=IGNORE` либо `MOD F00=PAUSE`.

## Проверка на Sprinter

Прошейте `build/CURRENT.UF2` через USB BOOTSEL, скопируйте EXE и тестовые
данные из CURRENT.ZIP (либо CURRENT.IMG). UF2 и IMG в ZIP не включены.
Сначала `UGCFG ULTRAGS`, `UGCFG INFO`, `UGMEM INFO`. Для slot1 добавляйте
`/SLOT:1` ко всем UG-командам. Перед сменой музыки используйте STOP либо
`/REPLACE`; READY handles сохраняются до FREE/reset.

Исходный `/Users/dmitry/Downloads/mods/bruno_-_bst.mod` не включён в поставку.
Скопируйте его на Sprinter под именем `BST.MOD`, сохранив все байты.
SHA256: `024f4b4a2c4ab31524243dfaa389b7dd38b3af4d2cdd37d6cbf6efab03d70a8a`.

```text
UGPLAY BST.MOD
UGMON /COUNT:1
```

Ожидается `MOD F00=IGNORE`. Примерно через20 секунд от запуска снова
выполните `UGMON /COUNT:1`: музыка должна продолжаться после
order4/pattern3/row55; `state=1`. На естественном конце, около151.14 секунды
от PLAY, `state=3` (EOF). Контроль можно повторить с UGPF вместо UGPLAY;
UGPF сохраняет экспериментальный статус Turbo-write, не снимает REAL gate.

```text
UGPLAY BST.MOD /F00:PAUSE
```

Ожидается `MOD F00=PAUSE`; на19.04 секунде позиция замирает:
`order,row,tick,speed,bpm=4,55,0,4,125`, `state=2`. Музыка молчит,
handle остаётся pinned. Два `UGMON /COUNT:1` с промежутком в несколько секунд
должны показать одинаковую позицию. Затем:

```text
UGPLAY RESUME
UGMON /COUNT:1
```

Музыка продолжается с сохранённой позиции. Для проверки HANDLE:

```text
UGLOAD BST.MOD /TYPE:MOD /VERIFY
UGPLAY HANDLE <handle> /F00:IGNORE /REPLACE
UGPLAY HANDLE <handle> /F00:PAUSE /REPLACE
```

Подставьте handle из UGLOAD; повторите без `/VERIFY` и с UGPF.

Короткие файлы F00MOD4.MOD/F00MOD8.MOD содержат speed3/BPM150, F00 на row1,
другую ноту на row2 и конец после row3. В IGNORE они заканчиваются за0.20s;
в PAUSE останавливаются на0.05s, RESUME продолжает. Для слышимого повтора:

```text
UGPLAY F00MOD8.MOD /LOOP /REPLACE
UGPLAY FX FX8.WAV /LOOP
UGPLAY F00MOD8.MOD /LOOP /F00:PAUSE /REPLACE
UGMON /COUNT:1
UGPLAY RESUME
UGPLAY STOP
UGPLAY FXSTOP ALL
```

FX должны звучать во время F00-паузы и продолжения MOD. Запишите прошивку/слот,
имя трека, вывод UGMON до/после F00 и EOF, качество звука, PSRAM/underrun errors.
До этого подтверждения статус исправления остаётся REAL_PENDING.

## Программное доказательство

Production C/UBSan: MOD4/MOD8, обе политики, начальное/изменяемое GS6A,
исторические LOAD/PLAY и66, SEEK/LOOP, RESUME/pins, независимый FX,
все недопустимые flag bytes и exact source readback. Actual EXE UGPLAY/UGPF:
файл/HANDLE, default/IGNORE/PAUSE, FAST/VERIFY, ошибки синтаксиса,
PCM HANDLE до замещения foreground, отсутствие capability, исходный BST.MOD.

libxmp4.7.0 определяет BST.MOD как Noisetracker M.K. Все7557 тиков совпадают
по order/pattern/row/tick/speed/BPM. Наш trace отмечает начало тика, libxmp —
конец: `UG.frames/48 == xmp.time_ms - xmp.frame_us/1000`. IGNORE EOF151.14s;
PAUSE19.04s order4/pattern3/row55. Исходный SHA256 сохранён.
Отчёты: `build/host/f00/`, `build/evidence/f00-exe.json`,
`build/delivery-evidence/s8a/`; независимая сборка — `build/reproducibility/`.
Физические gates S7/S8a и известные S8c REAL_FAIL остаются открытыми.
