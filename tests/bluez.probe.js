// Read-only: prints paired BlueZ audio devices. Connects nothing.
//   gjs -m tests/bluez.probe.js
import GLib from 'gi://GLib';

import {BluezClient} from '../extension/lib/bluez.js';

const loop = new GLib.MainLoop(null, false);
const client = new BluezClient();
await client.start();
for (const d of client.audioDevices) {
    print(JSON.stringify({name: d.name, address: d.address, paired: d.paired,
        connected: d.connected, hasOutput: d.hasOutput, hasInput: d.hasInput}));
}
client.destroy();
GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
    loop.quit();
    return GLib.SOURCE_REMOVE;
});
loop.run();
