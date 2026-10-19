# Аппаратный отказ GUS -> ULTRAGS, 2026-10-18

Пользователь выполнил первые команды Tester Notes на Sprinter. До переключения
INFO/LIST читаются, mode1 GUS VERIFIED. После одного MODE ULTRAGS фактический
mode8 виден, но чтение каталога нестабильно. Перезапуск Sprinter возвращает GUS
и восстанавливает сценарий. SAVE на карте не подтверждался.

Установленная прошивка по сообщению пользователя:
`build/S7-review/multifw-release/picogus.uf2`, SHA-256 локального файла
`6f8731d4596bab5d00eb919b4fe1f75bb206edaa29233d2e347e229f43bcf3ce`.
SHA установленного на карте файла отдельно аппаратно не считан.
Источник наблюдений: присланные фотографии `photo_2026-10-18_17-50-21.jpg`,
`photo_2026-10-18_17-50-25.jpg`, `photo_2026-10-18_17-59-39.jpg`,
`photo_2026-10-18_17-59-44.jpg`. EXE hash на стенде не зафиксирован.

Последние два снимка показывают разные чтения того же каталога:

```text
INFO: selector/echo/step=E5 E5 04
header=55 47 43 46 FF 00 08 FF FF 00 00 00 00 00 00 00
active=08 ULTRAGS boot_result=FF
LIST: selector/echo/step=E5 E5 04
header=FF 47 43 46 01 00 08 10 FF 00 00 00 00 00 00 00
```

Правильный header: `55 47 43 46 01 00 08 10 94 00 00 00 00 00 00 00`.
Правильные bytes продолжаются после потерянных samples, записи также содержат
FF в разных позициях. Поэтому утверждение «образ без каталога» не подтверждается.
Selector совпал, а consuming reads ненадёжны. Нельзя повторять отдельные bytes
или менять сохранённый режим после такого отказа. Старый INFO ошибочно печатал
RESULT PASS при невалидном каталоге; это отдельно исправлено.

В ULTRAGS найден дополнительный native decoder перед CONFIG handshake;
baseline IOR PIO утверждает IOCHRDY только после software condition. Новый
fixed CONFIG dispatch обходит decoder для 1D0..1D2 на чтение/запись. В ULTRAGS
polling приоритет IOR; idle RX не запрашивает timer на каждой итерации.
PIO, другие режимы, protocol4/API1.0 и Settings не меняются.

Программное доказательство: полный production handle_ior, SOUND_ULTRAGS,
production bundled ug_runtime_init/watchdog handoff. Конечная инъекция задержки
decoder заставляет хост получить FF, хотя snapshot index продвигается.
Прежний порядок отвергается mutation-тестом, новый читает полный каталог,
native и чужие адреса сохраняют свой маршрут. Это **не измерение** задержки
в ns и не доказательство достаточного запаса на физической карте.

Исправленная поставка: `build/cfg-card-failure/ultrags/cfg-package/`.
Установить её PGMULTI.UF2, обновить EXE и повторить TESTER.TXT. Если отказ
сохранится, нужны INFO/LIST /DIAG до reset и измерения IOR/IOCHRDY/data под
нагрузкой I2S/PSRAM. Первоначальный REAL сценарий не прошёл. Повтор исправления
остаётся REAL_PENDING; S7 IN_PROGRESS.

## Повтор после CONFIG fix: каталог исправлен, INFO ещё отказывает

Новые фотографии: `photo_2026-10-18_18-33-54.jpg` и
`photo_2026-10-18_18-33-58.jpg`. Общие protocol=04, active=08, boot_result=00,
BASE=02A0, alias=FFFF. LIST: ULTRAGS PRESENT VERIFIED, RESULT PASS.
Каталог валиден, stored/computed CRC одинаковы `4A B1 E4 1C`; это совпадает
с runtime catalogue cfg-card-failure (UF2 SHA-256
`7b3a05fabd7ea5c4666e26674faab444b87be36f98397807cde25d5fcaa5278f`).
Сам Flash hash на стенде не считывался.

MODE и следующий INFO: `INFO bytes/raw frame=02 00 FF`, INFO_LENGTH code=9.
При корректном ответе длина должна быть 24h. Успешный LIST проверяет общий
CONFIG путь, но не native transport. Первый fix был частичным.

Оставшиеся дефекты: внешний native decoder вызывается до assertion IOCHRDY;
native IOW передаёт только IO_END после всей обработки, не растягивая её заранее.
Новая правка проверяет native ownership inline и утверждает write IO_WAIT перед
frame/statistics. Обработчики и framing исполняются вместе в HOST fixture,
нормальные INFO и задержанное чтение проверяются для 16 BASE, old decoder/write
mutations отвергаются. Утилита при `00 FF` отменяет только свой frame, не делает
автоматический REBOOT/SAVE и не повторяет байт. Новая поставка cfg-native-a
должна быть прошита и проверена на карте; G0/REAL_PENDING остаётся открытым.
