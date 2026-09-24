#!/usr/bin/env bash
# Example one-off setup for Audio Presets: three presets plus names, icons and
# visibility for the devices. Everything can be changed later in Preferences.
#
# 1. Find your device names:
#      pactl list short sinks; pactl list short sources   # node.name
#      bluetoothctl devices Paired                         # Bluetooth MAC
# 2. Put them into the variables below.
# 3. Run:
#      examples/setup-example.sh           write to GSettings
#      examples/setup-example.sh --print   only print the JSON
set -euo pipefail

SCHEMA=org.gnome.shell.extensions.audio-presets
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
SCHEMADIR=${SCHEMADIR:-$ROOT/extension/schemas}

SPEAKERS=${SPEAKERS:-alsa_output.pci-0000_00_1f.3.analog-stereo}
HEADSET_OUT=${HEADSET_OUT:-alsa_output.usb-Acme_USB_Headset-00.analog-stereo}
HEADSET_IN=${HEADSET_IN:-alsa_input.usb-Acme_USB_Headset-00.mono-fallback}
MIC=${MIC:-alsa_input.usb-Acme_Studio_Mic-00.mono-fallback}
HDMI=${HDMI:-alsa_output.pci-0000_01_00.1.hdmi-stereo}
EARBUDS_MAC=${EARBUDS_MAC:-AA:BB:CC:DD:EE:FF}

devices=$(jq -nc \
  --arg speakers "$SPEAKERS" --arg hs_out "$HEADSET_OUT" --arg hs_in "$HEADSET_IN" \
  --arg mic "$MIC" --arg hdmi "$HDMI" --arg mac "$EARBUDS_MAC" '
  def wired($dir; $node; $vis; $name; $icon):
    {direction: $dir, match: {nodeName: $node}, visible: $vis, name: $name, icon: $icon};
  def bt($dir; $vis; $name; $icon):
    {direction: $dir, match: {btAddress: $mac}, visible: $vis, name: $name, icon: $icon};
  [
    wired("output"; $hs_out;   true;  "Headphones"; "audio-headphones-symbolic"),
    wired("output"; $speakers; true;  "Speakers";   "audio-speaker-cabinet-symbolic"),
    bt("output";               true;  "Earbuds";    "earbuds-symbolic"),
    wired("output"; $hdmi;     false; "Display";    "video-display-symbolic"),
    wired("input";  $hs_in;    true;  "Headset";    "audio-headset-symbolic"),
    wired("input";  $mic;      true;  "Studio mic"; "audio-input-microphone-studio-symbolic"),
    bt("input";                false; "Earbuds";    "earbuds-symbolic")
  ]')

presets=$(jq -nc \
  --arg speakers "$SPEAKERS" --arg hs_out "$HEADSET_OUT" --arg hs_in "$HEADSET_IN" \
  --arg mic "$MIC" --arg mac "$EARBUDS_MAC" '
  [
    {id: "headphones", name: "Headphones",
     output: ("output:" + $hs_out), input: ("input:" + $hs_in)},
    {id: "speakers", name: "Speakers",
     output: ("output:" + $speakers), input: ("input:" + $mic)},
    {id: "podcast", name: "Podcast",
     output: ("output:bt:" + $mac), input: ("input:" + $mic),
     fallbackOutput: ("output:" + $speakers)}
  ]')

if [[ ${1:-} == --print ]]; then
  jq . <<<"$devices"
  jq . <<<"$presets"
  exit 0
fi

gsettings --schemadir "$SCHEMADIR" set "$SCHEMA" devices "$devices"
gsettings --schemadir "$SCHEMADIR" set "$SCHEMA" presets "$presets"
echo "audio-presets: devices and presets written"
