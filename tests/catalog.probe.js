// Только чтение: каталог на настоящем Gvc и BlueZ, настройки в памяти.
// Ничего не переключает и не подключает.
//   GI_TYPELIB_PATH=/usr/lib/gnome-shell LD_LIBRARY_PATH=/usr/lib/gnome-shell gjs -m tests/catalog.probe.js
import GLib from 'gi://GLib';
import Gvc from 'gi://Gvc';

import {memorySettings} from './lib/settings.js';
import {BluezClient} from '../extension/lib/bluez.js';
import {DeviceCatalog} from '../extension/lib/catalog.js';

const loop = new GLib.MainLoop(null, false);
const mixer = new Gvc.MixerControl({name: 'audio-presets probe'});
const bluez = new BluezClient();
await bluez.start();
const catalog = new DeviceCatalog({mixer, settings: memorySettings(), bluez});

mixer.connect('state-changed', () => {
    if (mixer.get_state() !== Gvc.MixerControlState.READY)
        return;
    catalog.start();
    for (const dir of ['output', 'input']) {
        const def = catalog.defaultKey(dir);
        for (const e of catalog.list(dir)) {
            print(`${e.key === def ? '*' : ' '} ${e.present ? '+' : '-'} ${e.key}` +
                `\n      "${e.displayName}"  ${e.iconName}${e.bluetooth ? '  bt' : ''}`);
        }
    }
    catalog.destroy();
    bluez.destroy();
    loop.quit();
});
mixer.open();
loop.run();
