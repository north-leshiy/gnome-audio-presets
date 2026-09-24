## 1. Каркас

- [x] 1.1 Создать `extension/` с `metadata.json` (uuid `audio-presets@north-leshiy.github.io`, `shell-version ["50"]`, `gettext-domain`), пустыми `enable()`/`disable()` в `extension.js`, `stylesheet.css`, `LICENSE` (GPL-2.0-or-later). Проверка: `gnome-extensions info audio-presets@north-leshiy.github.io` после симлинка видит расширение.
- [x] 1.2 Добавить `build.sh`: `glib-compile-schemas`, компиляция `po/*.po` в `locale/`, `gnome-extensions pack` по желанию, а скомпилированные артефакты занести в `.gitignore`. Проверка: `./build.sh` отрабатывает без ошибок, `shellcheck build.sh` чист.
- [x] 1.3 Создать симлинк `~/.local/share/gnome-shell/extensions/audio-presets@north-leshiy.github.io` → `extension/`. Проверка: `readlink` показывает путь, а расширение загружается в `dbus-run-session -- gnome-shell --devkit --wayland` без ошибок в журнале.
- [x] 1.4 Описать схему `org.gnome.shell.extensions.audio-presets` с ключами `devices`, `presets`, `bt-connect-timeout`, `hide-native-indicators` (D4). Проверка: `gsettings --schemadir extension/schemas list-recursively org.gnome.shell.extensions.audio-presets` показывает значения по умолчанию.

## 2. Ядро без UI (проверяется в gjs вне Shell)

- [x] 2.1 `lib/matching.js`: построение ключей, точное совпадение, совпадение с суффиксом `.N` перед последним сегментом, BT-имена по MAC, отбрасывание `_internal`. Проверка: gjs-скрипт `tests/matching.test.js` с кейсами из спеки device-catalog (USB-гарнитура с `.7`, `pci-0000_00_1f.3`, `bluez_output_internal`) проходит.
- [x] 2.2 `lib/settings.js`: парсинг и валидация JSON `devices`/`presets`, отбрасывание битых записей с `console.warn`, запись с debounce. Проверка: `tests/settings.test.js` — невалидный JSON даёт пустой список и предупреждение, валидный читается и пишется без потерь.
- [x] 2.3 `lib/bluez.js`: `GetManagedObjects`, фильтр привязанных аудиоустройств, есть ли вход (HFP/HSP), подписка на `PropertiesChanged`/`InterfacesAdded`/`Removed`, асинхронный `connect(mac, cancellable)`. Проверка: скрипт только на чтение выводит BT-вкладыши `AA:BB:CC:DD:EE:01` с `paired=true`, `hasInput=true`. `connect` не вызывать без разрешения пользователя.
- [x] 2.4 `lib/catalog.js`: объединение потоков Gvc, сохранённых устройств и BlueZ; присутствие и отсутствие; автозапоминание новых устройств с `lastDescription`; сигнал `changed`. Проверка: скрипт только на чтение выводит все 8 текущих нод с ключами, а BT-вкладыши выводит как отсутствующее BT-устройство (выход и вход).
- [x] 2.5 `lib/switcher.js`: операция применения с `Gio.Cancellable` (D6), порядок source→sink, ожидание ноды по `changed` каталога, таймаут, запасной выход, отмена предыдущей операции, вычисление активного пресета (D7). Проверка: `tests/switcher.test.js` на фейковых каталоге, BlueZ и mixer покрывает сценарии из спеки preset-switching: присутствуют; BT подключился; таймаут с fallback; таймаут без fallback; отмена; внешняя смена устройства.

## 3. Панель и меню

- [x] 3.1 `ui/nativeHider.js`: ждать `quickSettings._volumeOutput`/`_volumeInput`, снять их из `_indicators` с запоминанием индексов и вернуть в `disable()` (D10); без приватных полей работать без скрытия и писать warning. Проверка в devkit: родные значки пропадают, слайдеры в Quick Settings на месте, после `gnome-extensions disable` значки возвращаются на прежние места.
- [x] 3.2 `lib/icons.js` и `icons/`: курированный список, три SVG (колонка, студийный микрофон, Bootstrap `earbuds` с `NOTICE`), путь поиска для St. Проверка в devkit: все иконки из списка отображаются в цвете темы, в том числе в светлой.
- [x] 3.3 `ui/indicator.js`: `PanelMenu.Button` с `[out/in]`, реакция на смену default, класс `privacy-indicator` по правилу D9, прокрутка громкости с OSD. Проверка в devkit: иконки совпадают с `pactl get-default-sink/source`; при записи (`pw-record /dev/null`) иконка входа выделена, при mute выделение снимается; колесо меняет громкость и показывает OSD.
- [x] 3.4 `ui/streamSlider.js`: слайдер потока с mute, `allow-volume-above-100-percent`, переключением на новый поток при смене default (D8). Проверка в devkit: громкость в `wpctl get-volume @DEFAULT_AUDIO_SINK@` совпадает со слайдером в обе стороны.
- [x] 3.5 `ui/menu.js`: ряд пресетов (иконки и имя, выделение активного, состояние «подключение»), плитки выходов и входов (скрытые не показываются, отсутствующие BT приглушены и кликабельны, отсутствующие проводные не показываются), два слайдера, пустое состояние с переходом в prefs. Проверка в devkit по сценариям спеки audio-menu. Переключение пресетов — только с разрешения пользователя, звук реальный.
- [x] 3.6 Уведомления `Main.notify` для fallback и ошибок подключения, тексты через gettext. Проверка: в devkit при выключенном Bluetooth-адаптере или с заведомо неверным MAC в тестовом пресете приходит уведомление об ошибке, и default не меняются.

## 4. Окно настроек

- [x] 4.1 `prefs.js`, страница «Devices»: группы выходов и входов, пометка «не подключено», переключатель видимости, поле имени, выбор иконки из `lib/icons.js` с превью. Проверка: `gnome-extensions prefs audio-presets@north-leshiy.github.io` открывается; при изменении видимости или имени меню в devkit обновляется без перезапуска.
- [x] 4.2 Страница «Presets»: добавить, удалить, переименовать, переупорядочить; выбор выхода, входа и запасного выхода среди всех устройств каталога; «неизвестное устройство» для битых ссылок. Проверка: созданный пресет появляется в меню, его порядок совпадает с prefs, а `gsettings get … presets` содержит ожидаемый JSON.

## 5. Локализация и документация

- [x] 5.1 Обернуть все строки в `_()`, собрать `po/audio-presets.pot` через `xgettext`, перевести в `po/ru.po`. Проверка: при `LANGUAGE=ru` в devkit меню и prefs на русском, а `msgfmt --check po/ru.po` чист.
- [x] 5.2 README: установка через симлинк, `build.sh`, отладка в devkit с предупреждением про реальный звук, готовая команда `gsettings set … presets '<JSON>'` с тремя примерными пресетами («Наушники», «Колонки», «Подкаст» с fallback на Колонки) и `devices` с его именами и иконками. Проверка: после команды из README меню в devkit показывает три пресета с нужными иконками.

## 6. Приёмка и переход

- [x] 6.1 Сквозная проверка в devkit вместе с включённым QSAP: пресеты «Наушники» и «Колонки» переключают обе стороны; «Подкаст» подключает BT-вкладыши, или по таймауту уходит на Колонки с уведомлением; подсветка активного пресета следует за внешней сменой через `wpctl set-default`. Делается только когда пользователь разрешит переключать звук и Bluetooth.
- [x] 6.2 Пользователь перелогинивается, включает `audio-presets@north-leshiy.github.io` и сам выключает QSAP. Проверка: на панели одна кнопка звука `[out/in]`, родных значков громкости нет, `journalctl --user -b | grep audio-presets` без ошибок.
