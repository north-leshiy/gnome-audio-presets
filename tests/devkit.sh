#!/usr/bin/env bash
# Вложенный GNOME Shell (devkit) в полностью изолированном окружении:
# своя шина D-Bus, свой dconf (XDG_CONFIG_HOME), свой каталог расширений
# (XDG_DATA_HOME) — включены только audio-presets и тестовый помощник.
# Настройки и расширения основной сессии не трогаются.
# PipeWire и BlueZ — НАСТОЯЩИЕ: пресет во вложенном Shell переключит реальный звук.
#
#   tests/devkit.sh start [--seed] [extra-uuid ...]   запустить в фоне
#     --seed — записать пресеты скриптом $DEVKIT_SEED (по умолчанию examples/setup-example.sh)
#   tests/devkit.sh eval 'JS'                           выполнить JS во вложенном Shell
#   tests/devkit.sh shot out.png                        скриншот вложенного Shell
#   tests/devkit.sh click X Y                           клик во вложенном Shell
#   tests/devkit.sh log                                 путь к логу
#   tests/devkit.sh stop
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
STATE=${DEVKIT_STATE:-${XDG_RUNTIME_DIR:-/tmp}/audio-presets-devkit}
LOG=$STATE/shell.log
BUS_FILE=$STATE/bus
PIDS_FILE=$STATE/pids

bus() {
  [[ -s $BUS_FILE ]] || { echo "devkit is not running" >&2; exit 1; }
  cat "$BUS_FILE"
}

start() {
  local seed=0 extra=()
  for a in "$@"; do
    if [[ $a == --seed ]]; then seed=1; else extra+=("$a"); fi
  done
  [[ -s $BUS_FILE ]] && { echo "already running (tests/devkit.sh stop)" >&2; exit 1; }

  "$ROOT/build.sh"
  mkdir -p "$STATE/config" "$STATE/data/gnome-shell/extensions"
  ln -sfn "$ROOT/extension" "$STATE/data/gnome-shell/extensions/audio-presets@north-leshiy.github.io"
  ln -sfn "$ROOT/tests/devkit-helper" "$STATE/data/gnome-shell/extensions/devkit-helper@audio-presets.test"
  # Расширения основной сессии, если попросили (например, QSAP для проверки совместимости).
  local u
  for u in "${extra[@]}"; do
    ln -sfn "$HOME/.local/share/gnome-shell/extensions/$u" "$STATE/data/gnome-shell/extensions/$u"
  done

  # ВАЖНО: окружение изоляции выставляется ДО запуска dbus-daemon. Сервисы
  # (dconf-service!) активируются шиной с её окружением; без этого dconf-service
  # пишет в настоящий ~/.config/dconf/user основной сессии.
  export XDG_CONFIG_HOME=$STATE/config
  export XDG_DATA_HOME=$STATE/data
  local real_dconf=$HOME/.config/dconf/user before
  before=$(stat -c %Y.%s "$real_dconf" 2>/dev/null || echo none)

  local out addr pid
  out=$(dbus-daemon --session --fork --print-address=1 --print-pid=1)
  addr=$(sed -n 1p <<<"$out")
  pid=$(sed -n 2p <<<"$out")
  echo "$addr" >"$BUS_FILE"
  echo "$pid" >"$PIDS_FILE"
  export DBUS_SESSION_BUS_ADDRESS=$addr

  # Проверка изоляции ДО любой записи: поднять dconf-service на этой шине и
  # убедиться по его окружению, что он пишет в $STATE/config.
  gdbus introspect --address "$addr" --dest ca.desrt.dconf \
    --object-path /ca/desrt/dconf/Writer/user >/dev/null
  local dconf_pid dconf_cfg
  dconf_pid=$(gdbus call --address "$addr" --dest org.freedesktop.DBus \
    --object-path /org/freedesktop/DBus \
    --method org.freedesktop.DBus.GetConnectionUnixProcessID ca.desrt.dconf |
    grep -oE '[0-9]+' | tail -1)
  dconf_cfg=$(tr '\0' '\n' <"/proc/$dconf_pid/environ" | sed -n 's/^XDG_CONFIG_HOME=//p')
  if [[ $dconf_cfg != "$STATE/config" ]]; then
    echo "ABORT: nested dconf-service (pid $dconf_pid) has XDG_CONFIG_HOME='$dconf_cfg'" >&2
    stop
    exit 1
  fi

  # Второй рубеж: после первой записи настоящая база не должна измениться.
  gsettings set org.gnome.shell welcome-dialog-last-shown-version '999'
  if [[ $(stat -c %Y.%s "$real_dconf" 2>/dev/null || echo none) != "$before" ]]; then
    echo "ABORT: nested dconf is not isolated, real $real_dconf changed" >&2
    stop
    exit 1
  fi

  local uuids="'audio-presets@north-leshiy.github.io', 'devkit-helper@audio-presets.test'"
  for u in "${extra[@]}"; do uuids+=", '$u'"; done
  gsettings set org.gnome.shell enabled-extensions "[$uuids]"
  gsettings set org.gnome.shell disable-user-extensions false
  if ((seed)); then
    "${DEVKIT_SEED:-$ROOT/examples/setup-example.sh}" >/dev/null
  fi

  gnome-shell --devkit --wayland >"$LOG" 2>&1 &
  echo $! >>"$PIDS_FILE"
  # ждём, пока Shell займёт имя на шине
  local _
  for _ in $(seq 50); do
    if gdbus call --address "$addr" --dest org.freedesktop.DBus --object-path /org/freedesktop/DBus \
      --method org.freedesktop.DBus.NameHasOwner org.gnome.Shell 2>/dev/null | grep -q true; then
      sleep 2
      echo "devkit started, log: $LOG"
      return 0
    fi
    sleep 0.2
  done
  echo "Shell did not start, see $LOG" >&2
  exit 1
}

stop() {
  [[ -s $PIDS_FILE ]] || return 0
  local shell_pid bus_pid
  bus_pid=$(sed -n 1p "$PIDS_FILE")
  shell_pid=$(sed -n 2p "$PIDS_FILE")
  [[ -n $shell_pid ]] && kill "$shell_pid" 2>/dev/null || true
  sleep 1
  [[ -n $bus_pid ]] && kill "$bus_pid" 2>/dev/null || true
  : >"$PIDS_FILE"
  : >"$BUS_FILE"
  echo "devkit stopped"
}

shell_eval() {
  local reply
  reply=$(gdbus call --address "$(bus)" --dest org.gnome.Shell --object-path /org/gnome/Shell \
    --method org.gnome.Shell.Eval "$1")
  echo "$reply"
  [[ $reply == "(true,"* ]]
}

# Клик левой кнопкой в координатах вложенного Shell (виртуальный указатель Clutter).
click() {
  shell_eval "
    const {Clutter, GLib} = imports.gi;
    globalThis.__apPointer ??= Clutter.get_default_backend().get_default_seat()
      .create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
    const p = globalThis.__apPointer, t = GLib.get_monotonic_time();
    p.notify_absolute_motion(t, $1, $2);
    p.notify_button(t + 20000, Clutter.BUTTON_PRIMARY, Clutter.ButtonState.PRESSED);
    p.notify_button(t + 40000, Clutter.BUTTON_PRIMARY, Clutter.ButtonState.RELEASED);
    'ok'" >/dev/null
}

shot() {
  local file
  file=$(realpath -m "$1")
  gdbus call --address "$(bus)" --dest org.gnome.Shell.Screenshot \
    --object-path /org/gnome/Shell/Screenshot \
    --method org.gnome.Shell.Screenshot.Screenshot false false "$file" >/dev/null
  echo "$file"
}

cmd=${1:-}
shift || true
case "$cmd" in
  start) start "$@" ;;
  stop) stop ;;
  eval) shell_eval "$1" ;;
  shot) shot "$1" ;;
  click) click "$1" "$2" ;;
  log) echo "$LOG" ;;
  *) sed -n '2,15p' "$0"; exit 2 ;;
esac
