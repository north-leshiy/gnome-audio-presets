import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {getMixerControl} from 'resource:///org/gnome/shell/ui/status/volume.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {BluezClient} from './lib/bluez.js';
import {DeviceCatalog} from './lib/catalog.js';
import {PresetSwitcher} from './lib/switcher.js';
import {HIDE_NATIVE_KEY} from './lib/settings.js';
import {AudioIndicator} from './ui/indicator.js';
import {NativeHider} from './ui/nativeHider.js';

export default class AudioPresetsExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        // Shared with the built-in volume indicators; owned by the Shell.
        const mixer = getMixerControl();

        this._bluez = new BluezClient();
        this._bluez.start();

        this._catalog = new DeviceCatalog({mixer, settings: this._settings, bluez: this._bluez});
        this._catalog.start();

        this._switcher = new PresetSwitcher({
            catalog: this._catalog,
            mixer,
            settings: this._settings,
            bluez: this._bluez,
            gettext: s => this.gettext(s),
            notify: (title, body) => Main.notify(title, body),
        });

        this._indicator = new AudioIndicator({
            catalog: this._catalog,
            switcher: this._switcher,
            mixer,
            openPreferences: () => this.openPreferences(),
        });
        Main.panel.addToStatusArea(this.uuid, this._indicator);

        this._hider = new NativeHider();
        this._settings.connectObject(`changed::${HIDE_NATIVE_KEY}`,
            () => this._syncHider(), this);
        this._syncHider();
    }

    disable() {
        this._settings.disconnectObject(this);
        this._hider.restore();
        this._hider = null;

        this._indicator.destroy();
        this._indicator = null;
        this._switcher.destroy();
        this._switcher = null;
        this._catalog.destroy();
        this._catalog = null;
        this._bluez.destroy();
        this._bluez = null;
        this._settings = null;
    }

    _syncHider() {
        this._hider.restore();
        if (this._settings.get_boolean(HIDE_NATIVE_KEY))
            this._hider.hide();
    }
}
