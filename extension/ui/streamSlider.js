// Volume slider for one Gvc stream: device name, mute button, slider.
// The volume logic follows the built-in StreamSlider in ui/status/volume.js
// (its classes are not exported), without the device selection menu.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gvc from 'gi://Gvc';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {OUTPUT} from '../lib/matching.js';

const ALLOW_AMPLIFIED_VOLUME_KEY = 'allow-volume-above-100-percent';
const UNMUTE_DEFAULT_VOLUME = 0.25;

const OUTPUT_ICONS = [
    'audio-volume-muted-symbolic',
    'audio-volume-low-symbolic',
    'audio-volume-medium-symbolic',
    'audio-volume-high-symbolic',
    'audio-volume-overamplified-symbolic',
];
const INPUT_ICONS = [
    'microphone-sensitivity-muted-symbolic',
    'microphone-sensitivity-low-symbolic',
    'microphone-sensitivity-medium-symbolic',
    'microphone-sensitivity-high-symbolic',
];

export const StreamSlider = GObject.registerClass(
class AudioPresetsStreamSlider extends PopupMenu.PopupBaseMenuItem {
    _init(control, direction) {
        super._init({activate: false, style_class: 'audio-presets-slider-item'});
        this._control = control;
        this._direction = direction;
        this._icons = direction === OUTPUT ? OUTPUT_ICONS : INPUT_ICONS;
        this._stream = null;
        this._inDrag = false;
        this._notifyVolumeChangeId = 0;
        this._volumeCancellable = null;

        const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        this.add_child(box);

        this._label = new St.Label({style_class: 'audio-presets-slider-label'});
        box.add_child(this._label);

        const row = new St.BoxLayout({x_expand: true});
        box.add_child(row);

        this._icon = new St.Icon({style_class: 'popup-menu-icon'});
        this._muteButton = new St.Button({
            child: this._icon,
            style_class: 'icon-button flat audio-presets-mute',
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._muteButton.connect('clicked', () => this._toggleMute());
        row.add_child(this._muteButton);

        this.slider = new Slider(0);
        this.slider.x_expand = true;
        this.slider.accessible_name = direction === OUTPUT ? _('Volume') : _('Microphone');
        this._sliderChangedId = this.slider.connect('notify::value', () => this._sliderChanged());
        this.slider.connect('drag-begin', () => (this._inDrag = true));
        this.slider.connect('drag-end', () => {
            this._inDrag = false;
            this._notifyVolumeChange();
        });
        row.add_child(this.slider);

        this._soundSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.sound'});
        this._soundSettings.connectObject(`changed::${ALLOW_AMPLIFIED_VOLUME_KEY}`,
            () => this._amplifySettingsChanged(), this);
        this._amplifySettingsChanged();

        this.connect('destroy', () => {
            this._stream?.disconnectObject(this);
            if (this._notifyVolumeChangeId)
                GLib.source_remove(this._notifyVolumeChangeId);
            this._volumeCancellable?.cancel();
        });
        this._sync();
    }

    get stream() {
        return this._stream;
    }

    set stream(stream) {
        if (stream === this._stream)
            return;
        this._stream?.disconnectObject(this);
        this._stream = stream;
        stream?.connectObject(
            'notify::is-muted', () => this._updateVolume(),
            'notify::volume', () => this._updateVolume(), this);
        this._sync();
    }

    setName(text) {
        this._label.text = text ?? '';
    }

    /** One scroll step from the panel; returns true if the volume changed. */
    step(nSteps) {
        return this._stream ? this.slider.step(nSteps) : false;
    }

    showOSD() {
        if (!this._stream)
            return;
        const gicon = new Gio.ThemedIcon({name: this._iconName()});
        const level = this._stream.volume / this._control.get_vol_max_norm();
        Main.osdWindowManager.showAll(gicon, null, level, this._maxLevel());
    }

    _sync() {
        this.visible = this._stream !== null;
        if (this._stream)
            this._updateVolume();
    }

    _toggleMute() {
        if (!this._stream)
            return;
        const {isMuted} = this._stream;
        if (isMuted && this._stream.volume === 0) {
            this._stream.volume = UNMUTE_DEFAULT_VOLUME * this._control.get_vol_max_norm();
            this._stream.push_volume();
        }
        this._stream.change_is_muted(!isMuted);
    }

    _sliderChanged() {
        if (!this._stream)
            return;
        const volume = this.slider.value * this._control.get_vol_max_norm();
        const prevMuted = this._stream.is_muted;
        const prevVolume = this._stream.volume;
        if (volume < 1) {
            this._stream.volume = 0;
            if (!prevMuted)
                this._stream.change_is_muted(true);
        } else {
            this._stream.volume = volume;
            if (prevMuted)
                this._stream.change_is_muted(false);
        }
        this._stream.push_volume();

        if (this._stream.volume !== prevVolume && !this._notifyVolumeChangeId && !this._inDrag) {
            this._notifyVolumeChangeId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 30, () => {
                this._notifyVolumeChangeId = 0;
                this._notifyVolumeChange();
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _notifyVolumeChange() {
        if (this._direction !== OUTPUT || !this._stream)
            return;
        this._volumeCancellable?.cancel();
        this._volumeCancellable = null;
        if (this._stream.state === Gvc.MixerStreamState.RUNNING)
            return; // no separate feedback sound while audio is playing
        this._volumeCancellable = new Gio.Cancellable();
        global.display.get_sound_player().play_from_theme('audio-volume-change',
            _('Volume changed'), this._volumeCancellable);
    }

    _updateVolume() {
        const muted = this._stream.is_muted;
        this.slider.block_signal_handler(this._sliderChangedId);
        this.slider.value = muted ? 0 : this._stream.volume / this._control.get_vol_max_norm();
        this.slider.unblock_signal_handler(this._sliderChangedId);
        this._icon.icon_name = this._iconName();
        this._muteButton.accessible_name = muted ? _('Unmute') : _('Mute');
    }

    _iconName() {
        const volume = this._stream?.volume ?? 0;
        if (!this._stream || this._stream.is_muted || volume <= 0)
            return this._icons[0];
        const n = Math.ceil(3 * volume / this._control.get_vol_max_norm());
        return this._icons[Math.clamp(n, 1, this._icons.length - 1)];
    }

    _maxLevel() {
        const max = this._allowAmplified
            ? this._control.get_vol_max_amplified() : this._control.get_vol_max_norm();
        return max / this._control.get_vol_max_norm();
    }

    _amplifySettingsChanged() {
        this._allowAmplified = this._soundSettings.get_boolean(ALLOW_AMPLIFIED_VOLUME_KEY);
        this.slider.maximum_value = this._maxLevel();
        this.slider.clearMarks();
        if (this._allowAmplified)
            this.slider.addMark(1);
        if (this._stream)
            this._updateVolume();
    }
});
