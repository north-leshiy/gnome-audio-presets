## Context

Мотивация — в proposal.md. Требования — в `specs/*/spec.md`. Здесь только то, что определяет подход.

- GNOME Shell 50.1, Wayland, ESM. Перезапустить Shell можно только перелогином, поэтому отлаживаем во вложенном `dbus-run-session -- gnome-shell --devkit --wayland`: `mutter-dev-bin` установлен, запуск проверен. Вложенный Shell работает с **настоящим** PipeWire и загружает включённые расширения пользователя.
- Звук: PipeWire 1.6.2 и WirePlumber 0.5.13. Shell работает с ними через Gvc (pulse-слой). Id нод в Gvc внутренние и не совпадают с id в `wpctl`. `MixerStream.name` равен `node.name`.
- В `ui/status/volume.js` экспортированы `getMixerControl()`, `OutputIndicator` и `InputIndicator`. Классы слайдеров не экспортированы.
- Родные значки (`quickSettings._volumeOutput` и `_volumeInput`, наследники `SystemIndicator`) сами пересчитывают свою видимость (`_syncIndicatorsVisible`, `bind_property` у входа). Поэтому `hide()` на них не держится.
- Модуль `extension.js` импортируется один раз за жизнь процесса, поэтому всё состояние живёт в экземпляре и создаётся в `enable()`.

## Goals / Non-Goals

**Goals:**
- Состояние интерфейса выводится из одной модели: каталог + текущие default + состояние применения. Никаких «ручных» перерисовок в разных местах.
- `disable()` возвращает Shell в исходное состояние: сигналы отключены, родные значки на месте, таймеры сняты.
- Код, который работает с Gvc, BlueZ и настройками, не зависит от UI, чтобы его можно было прогнать в gjs вне Shell.

**Non-Goals:**
- Поддержка Shell < 50 и публикация на extensions.gnome.org.
- Управление профилями карт и кодеками Bluetooth. Изменение конфигурации WirePlumber.
- Автоматический тест-стенд для Shell. Проверка идёт в devkit и в gjs-скриптах.

## Decisions

### D1. Структура: подкаталог `extension/` и модули
```
extension/
  metadata.json          uuid audio-presets@north-leshiy.github.io, shell-version ["50"], gettext-domain
  extension.js           enable/disable, сборка модулей
  lib/settings.js        чтение/запись JSON-ключей GSettings, валидация, дефолты
  lib/catalog.js         DeviceCatalog: Gvc-потоки + BlueZ + сохранённые устройства
  lib/bluez.js           BluezClient: ObjectManager, Device1.Connect, Connected
  lib/switcher.js        PresetSwitcher: применение, ожидание, таймаут, отмена, активный пресет
  lib/matching.js        чистые функции: ключи, суффиксы .N, MAC <-> имена нод
  ui/indicator.js        PanelMenu.Button: [out/in], privacy, scroll
  ui/menu.js             ряд пресетов, плитки, слайдеры, пустое состояние
  ui/streamSlider.js     свой слайдер для потока
  ui/nativeHider.js      снятие/возврат родных значков
  prefs.js               Adw: страницы «Devices» и «Presets»
  schemas/org.gnome.shell.extensions.audio-presets.gschema.xml
  icons/                 audio-speaker-cabinet-, audio-input-microphone-studio-, earbuds-symbolic.svg
  po/                    ru.po; LICENSE, NOTICE (Bootstrap Icons, MIT)
```
Симлинк `~/.local/share/gnome-shell/extensions/audio-presets@north-leshiy.github.io` указывает на `extension/`. Так `openspec/` и `docs/` не попадают в расширение.
*Альтернатива:* корень репозитория как расширение. Отклонена, потому что тогда в расширение попадает всё лишнее.

### D2. Звук: Gvc через `getMixerControl()`, без pactl и wpctl
Используем синглтон Shell: одно соединение и уже готовое состояние READY. Устройства по умолчанию переключаем через `set_default_sink(stream)` и `set_default_source(stream)`. `change_output(uiDevice)` не используем: он работает через UI-device и порт, а нам нужен именно поток по `node.name`.
*Альтернативы:* вызывать `pactl`/`wpctl` через subprocess (лишние процессы, парсинг, а события всё равно нужны из Gvc); WirePlumber D-Bus/`wp` GI (в Shell нет, пришлось бы тянуть зависимость).

### D3. Ключ устройства и матчинг
Ключ имеет вид `output:<node.name>` или `input:<node.name>` для проводных устройств и `output:bt:<MAC>` или `input:bt:<MAC>` для Bluetooth. Матчинг вынесен в чистые функции `lib/matching.js`:
1. Ищем точное совпадение `stream.name == nodeName`.
2. Если его нет, ищем имя вида `prefix + "." + \d+ + "." + lastSegment`, где `prefix.lastSegment == nodeName`. Суффикс вставлен перед последним сегментом, а из ключа ничего не вырезаем.
3. Для BT: `bluez_output.<MAC>` / `bluez_input.<MAC>`. Имена с `_internal` отбрасываются. Направление берём из того, в каком списке поток, `get_sinks()` или `get_sources()`. Мониторы (`*.monitor`) не показываем: в Gvc их нет среди sources, но фильтр оставляем на всякий случай.
*Альтернатива:* ключ по карте (`device.name` + направление). Отклонена, потому что Gvc не отдаёт `device.name` карты: `MixerCard.name` — это описание.

### D4. Настройки: JSON-строки в GSettings
Ключи: `devices` (s, по умолчанию `[]`), `presets` (s, `[]`), `bt-connect-timeout` (u, 15), `hide-native-indicators` (b, true). Запись устройства: `{direction, match: {nodeName} | {btAddress}, visible, name, icon, lastDescription}`; запись пресета: `{id, name, output, input, fallbackOutput}`, где устройства заданы ключами каталога. `lib/settings.js` парсит и валидирует каждую запись, а битые отбрасывает с `console.warn`. Пишем только из prefs и при автозапоминании нового устройства в Shell. Автозапоминание пишет с debounce, чтобы не дёргать dconf на каждом переподключении.
*Альтернатива:* `aa{sv}`. Он строже типизирован, но в prefs с ним неудобно работать и почти невозможно править через `gsettings set`. Отдельная схема с relocatable-путями на каждое устройство — избыточно.

### D5. BlueZ через `Gio.DBusProxy` на system bus
`BluezClient` читает `GetManagedObjects()`, подписывается на `InterfacesAdded`/`Removed` и `PropertiesChanged`, а наружу отдаёт список привязанных аудиоустройств: `Paired`, и UUID A2DP Sink `0000110b-…` или `Icon` вида `audio-*`. Вход у устройства есть, если объявлен HFP/HSP (`0000111e-…`/`00001108-…`). `connect(mac)` вызывает `Device1.Connect()` асинхронно. Ошибки D-Bus превращаются в причину для уведомления. Нет BlueZ или адаптера — модуль тихо отдаёт пустой список.

### D6. Применение пресета: одна «операция» с отменой
`PresetSwitcher.apply(target)` создаёт операцию с `Gio.Cancellable`. Новая операция отменяет предыдущую.
```
resolve(out,in) -> оба присутствуют? -> set_default_source(in); set_default_sink(out); done
          | нет (BT)
          v
  state=connecting -> bluez.connect(mac) (если не Connected)
          -> ждём catalog 'changed', пока нода не появится  | GLib timeout N с
          -> появилась: set_default_source(in); set_default_sink(out)
          -> таймаут/ошибка: fallback присутствует? -> применить (fallback,in) + notify
                                                  : notify(error), ничего не менять
```
Сначала ставим **source**, потом sink. Так вход пресета (USB-микрофон) становится default раньше, чем кто-нибудь успеет подключиться к loopback-микрофону BT-вкладыши, и WirePlumber не переводит их в HFP (`autoswitch-bluetooth-profile.lua` реагирует только на связанный поток захвата).
Ручной выбор устройства — та же операция с одной стороной и без fallback.
*Альтернатива:* ждать ноду через `stream-added` без каталога. Отклонена: матчинг с суффиксами и MAC всё равно живёт в каталоге.

### D7. Активный пресет вычисляется, а не хранится
На `default-sink-changed`/`default-source-changed` пересчитываем, какой первый пресет совпадает с парой `(out, in)` или `(fallback, in)`. Отдельного «последнего нажатого» не храним, поэтому внешняя смена устройств корректно снимает подсветку (spec preset-switching).

### D8. Свой слайдер вместо родного
`ui/streamSlider.js` построен на `Slider` из `ui/slider.js` и повторяет логику родного `StreamSlider`: `volume / get_vol_max_norm()`, `push_volume()`, `change_is_muted()`, ключ `org.gnome.desktop.sound allow-volume-above-100-percent`, OSD через `Main.osdWindowManager.showAll()`. Около 100 строк.
*Альтернатива:* взять конструктор через `quickSettings._volumeOutput._output.constructor`, как делает QSAP. Отклонена: это приватное API, и вместе с конструктором тянутся меню устройств, которые нам не нужны.

### D9. Индикатор приватности
Правило то же, что в родном `InputStreamSlider._maybeShowInput`: запись идёт, если в `get_source_outputs()` есть поток не от `org.gnome.VolumeControl`/`org.PulseAudio.pavucontrol`. Добавляем проверку, что default source не muted. Тогда иконка входа получает класс `privacy-indicator`. Пересчёт идёт на `stream-added`/`stream-removed` и `notify::is-muted`.

### D10. Скрытие родных значков: снятие актёров из контейнера
`nativeHider` запоминает индексы `_volumeOutput` и `_volumeInput` в `quickSettings._indicators` и вызывает `remove_child`. В `disable()` возвращает их через `insert_child_at_index`. Слайдеры Quick Settings — другие актёры в сетке меню, их это не затрагивает. `_volumeOutput` создаётся асинхронно, поэтому ждём свойство так же, как QSAP (`wait_property`), с ограничением по времени.
*Альтернатива:* `hide()` или `opacity=0`. Отклонена: `_syncIndicatorsVisible` и binding сразу возвращают видимость.

### D11. Иконки
Имена иконок хранятся строкой. Свои SVG отдаются как `Gio.FileIcon` на `extension/icons/<id>.svg` (`lib/icons.js: giconFor`), тема иконок не трогается: и St, и GTK4 перекрашивают файл, если его имя оканчивается на `-symbolic.svg`. Все свои SVG 16×16 и состоят только из заливок: Shell перекрашивает symbolic по `fill`. Курированный список `{id, label}` один на Shell и prefs (`lib/icons.js`).

### D12. Локализация
`gettext-domain` в metadata, в коде `this.gettext`/`_()` из `Extension` и `ExtensionPreferences`. `po/ru.po` компилируется в `locale/ru/LC_MESSAGES/*.mo` скриптом `build.sh`: через GNU gettext, если он установлен, иначе через Python Babel (`pybabel`). Модули `lib/` не импортируют gettext Shell: `PresetSwitcher` получает функцию перевода параметром, а `lib/icons.js` помечает подписи через `N_`. Скомпилированные `.mo` и `gschemas.compiled` в git не кладём.

### D13. Стенд devkit: полная изоляция и проверка до записи
`tests/devkit.sh` запускает вложенный Shell со своей шиной D-Bus, своим dconf (`XDG_CONFIG_HOME`) и своим каталогом расширений (`XDG_DATA_HOME`). Переменные выставляются **до** старта `dbus-daemon`: сервисы, в том числе `dconf-service`, шина активирует со своим окружением. Перед первой записью скрипт читает окружение `dconf-service` из `/proc` и прерывается, если там не изолированный путь. После первой записи он дополнительно сверяет mtime настоящей `~/.config/dconf/user`. Для проверки UI туда же подгружается тестовое расширение `tests/devkit-helper`: оно включает `unsafe_mode`, и через изолированную шину становятся доступны `Eval` и `Screenshot`.
*Почему:* первая версия скрипта выставляла `XDG_CONFIG_HOME` после старта шины и перезаписала `enabled-extensions` в основной сессии (2026-09-24, восстановлено вручную).

## Risks / Trade-offs

- [Приватные поля `quickSettings._volumeOutput` и `_indicators` изменятся в Shell 51] → Всё обращение собрано в `nativeHider`. Если поля нет, расширение работает без скрытия и пишет предупреждение.
- [QSAP параллельно двигает родные слайдеры и тоже лезет в `_volumeInput`] → Мы не трогаем слайдеры, только значки на панели. Совместную работу проверяем в devkit. После готовности пользователь выключает QSAP.
- [Проверка в devkit переключает реальный звук] → Проверки пресетов делаем не во время звонков. Сначала прогоняем `lib/*` в gjs вне Shell только на чтение.
- [BT-вкладыши периодически выдают `Failure in Bluetooth audio transport`] → Таймаут, запасной выход, уведомление.
- [Приложение с явно выбранным микрофоном BT-вкладышей переведёт их в HFP] → Вне расширения. Если будет мешать на практике, отключаем `bluetooth.autoswitch-to-headset-profile` в WirePlumber, это отдельное решение.
- [Нода BT появляется раньше, чем Gvc сообщает `stream-added`, или наоборот, и `lookup_*` пуст] → Ждём по событию каталога, а не по таймеру, и перепроверяем при каждом `stream-added`.
- [Автозапоминание пишет в dconf при каждом новом устройстве] → debounce, и пишем только при изменении множества.

## Migration Plan

1. Разработка в `extension/`, симлинк в `~/.local/share/gnome-shell/extensions/`.
2. Отладка в devkit: наше расширение и QSAP загружаются вместе.
3. Пользователь один раз вносит свои пресеты через prefs или готовой командой `gsettings set` из README.
4. Перелогин, `gnome-extensions enable audio-presets@north-leshiy.github.io`, затем пользователь сам делает `gnome-extensions disable quick-settings-audio-panel@rayzeq.github.io`.
5. Откат: выключить наше расширение, включить QSAP. Родные значки возвращаются в `disable()`.

## Open Questions

- Своя колонка и свой студийный микрофон или Bootstrap `speaker` и `mic`: решаем после просмотра вживую. Меняется только файл в `icons/` и запись в `lib/icons.js`.
