// Кнопка на панели: [иконка выхода / иконка входа], индикатор приватности
// микрофона и громкость колёсиком.
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {OUTPUT, INPUT} from '../lib/matching.js';
import {giconFor} from '../lib/icons.js';
import {AudioMenu} from './menu.js';

// Как в родном InputStreamSlider: эти приложения «пишут» только ради индикатора уровня.
const SKIPPED_RECORDERS = ['org.gnome.VolumeControl', 'org.PulseAudio.pavucontrol'];

export const AudioIndicator = GObject.registerClass(
class AudioPresetsIndicator extends PanelMenu.Button {
    _init({catalog, switcher, mixer, openPreferences}) {
        super._init(0.5, _('Audio Presets'));
        this._catalog = catalog;
        this._mixer = mixer;

        const box = new St.BoxLayout({style_class: 'panel-status-indicators-box'});
        this._outIcon = new St.Icon({style_class: 'system-status-icon'});
        this._inIcon = new St.Icon({style_class: 'system-status-icon'});
        box.add_child(this._outIcon);
        box.add_child(new St.Label({
            text: '/',
            style_class: 'audio-presets-panel-slash',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        box.add_child(this._inIcon);
        this.add_child(box);

        this._audioMenu = new AudioMenu(this.menu, {catalog, switcher, mixer, openPreferences});

        this._catalogId = catalog.connect('changed', () => this._sync());
        mixer.connectObject(
            'stream-added', () => this._syncPrivacy(),
            'stream-removed', () => this._syncPrivacy(),
            'default-source-changed', () => this._watchSource(), this);
        this.connect('scroll-event', (actor, event) => this._onScroll(event));
        this.connect('destroy', () => this._onDestroy());

        this._watchSource();
        this._sync();
    }

    _onDestroy() {
        this._catalog.disconnect(this._catalogId);
        this._mixer.disconnectObject(this);
        this._source?.disconnectObject(this);
        this._audioMenu.destroy();
    }

    _sync() {
        this._setIcon(this._outIcon, OUTPUT, 'audio-volume-muted-symbolic');
        this._setIcon(this._inIcon, INPUT, 'microphone-disabled-symbolic');
        const out = this._catalog.lookup(this._catalog.defaultKey(OUTPUT));
        const inp = this._catalog.lookup(this._catalog.defaultKey(INPUT));
        this.accessible_name = [out?.displayName, inp?.displayName].filter(Boolean).join(' / ') ||
            _('Audio Presets');
        this._syncPrivacy();
    }

    _setIcon(icon, direction, missingIcon) {
        const entry = this._catalog.lookup(this._catalog.defaultKey(direction));
        icon.gicon = giconFor(entry?.iconName ?? missingIcon);
    }

    /** Следим за mute текущего входа: от него зависит индикатор приватности. */
    _watchSource() {
        this._source?.disconnectObject(this);
        this._source = this._catalog.defaultStream(INPUT);
        this._source?.connectObject('notify::is-muted', () => this._syncPrivacy(), this);
        this._syncPrivacy();
    }

    _syncPrivacy() {
        const recording = this._catalog.ready && this._source && !this._source.is_muted &&
            this._mixer.get_source_outputs().some(
                o => !SKIPPED_RECORDERS.includes(o.get_application_id()));
        if (recording)
            this._inIcon.add_style_class_name('privacy-indicator');
        else
            this._inIcon.remove_style_class_name('privacy-indicator');
    }

    _onScroll(event) {
        if (event.get_flags() & Clutter.EventFlags.FLAG_POINTER_EMULATED)
            return Clutter.EVENT_PROPAGATE;
        let nSteps = 0;
        const direction = event.get_scroll_direction();
        if (direction === Clutter.ScrollDirection.DOWN) {
            nSteps = -1;
        } else if (direction === Clutter.ScrollDirection.UP) {
            nSteps = 1;
        } else if (direction === Clutter.ScrollDirection.SMOOTH) {
            const [, dy] = event.get_scroll_delta();
            nSteps = -dy;
            if (event.get_scroll_flags() & Clutter.ScrollFlags.INVERTED)
                nSteps *= -1;
        }
        const slider = this._audioMenu.outputSlider;
        if (slider.step(nSteps))
            slider.showOSD();
        return Clutter.EVENT_STOP;
    }
});
