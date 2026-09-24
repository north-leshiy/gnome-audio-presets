#!/usr/bin/env bash
# Nested GNOME Shell (devkit) in a fully isolated environment: its own D-Bus
# session, dconf (XDG_CONFIG_HOME) and extensions directory (XDG_DATA_HOME);
# only audio-presets and the test helper are enabled.
# Settings and extensions of the main session are not touched.
# PipeWire and BlueZ are REAL: a preset in the nested Shell switches real audio.
#
#   tests/devkit.sh start [--seed] [extra-uuid ...]   start in the background
#     --seed writes presets with $DEVKIT_SEED (default: examples/setup-example.sh)
#   tests/devkit.sh eval 'JS'                           run JS in the nested Shell
#   tests/devkit.sh shot out.png                        screenshot of the nested Shell
#   tests/devkit.sh click X Y                           click in the nested Shell
#   tests/devkit.sh log                                 path to the log
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
  # Extensions of the main session, if asked for (e.g. to check compatibility).
  local u
  for u in "${extra[@]}"; do
    ln -sfn "$HOME/.local/share/gnome-shell/extensions/$u" "$STATE/data/gnome-shell/extensions/$u"
  done

  # IMPORTANT: the isolation environment is set BEFORE dbus-daemon starts. The bus
  # activates services (dconf-service!) with its own environment; otherwise
  # dconf-service writes to the real ~/.config/dconf/user of the main session.
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

  # Check isolation BEFORE any write: start dconf-service on this bus and make
  # sure from its environment that it writes to $STATE/config.
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

  # Second line of defence: the real database must not change after the first write.
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

  # DEVKIT_HEADLESS=1: no window on screen, a virtual monitor instead; more
  # reliable for screenshots of GTK windows (in nested mode they sometimes do not draw).
  if [[ -n ${DEVKIT_HEADLESS:-} ]]; then
    gnome-shell --headless --virtual-monitor 1280x800 --wayland --no-x11 >"$LOG" 2>&1 &
  else
    gnome-shell --devkit --wayland >"$LOG" 2>&1 &
  fi
  echo $! >>"$PIDS_FILE"
  # wait until the Shell owns its name on the bus
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

# Left click at nested Shell coordinates (Clutter virtual pointer).
# Motion, press and release go in separate calls with pauses: GTK windows
# ignore a click that arrives in the same batch as the pointer entering the surface.
click() {
  local init="const {Clutter, GLib} = imports.gi;
    globalThis.__apPointer ??= Clutter.get_default_backend().get_default_seat()
      .create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
    const p = globalThis.__apPointer, t = GLib.get_monotonic_time();"
  shell_eval "$init p.notify_absolute_motion(t, $1 - 1, $2); 'ok'" >/dev/null
  sleep 0.2
  shell_eval "$init p.notify_absolute_motion(t, $1, $2); 'ok'" >/dev/null
  sleep 0.2
  shell_eval "$init p.notify_button(t, Clutter.BUTTON_PRIMARY, Clutter.ButtonState.PRESSED); 'ok'" >/dev/null
  sleep 0.1
  shell_eval "$init p.notify_button(t, Clutter.BUTTON_PRIMARY, Clutter.ButtonState.RELEASED); 'ok'" >/dev/null
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
