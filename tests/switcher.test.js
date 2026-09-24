import GLib from 'gi://GLib';

import {test, eq, ok, run} from './lib/assert.js';
import {memorySettings} from './lib/settings.js';
import {FakeMixer, FakeBluez, fakeStream} from './lib/fakes.js';
import {DeviceCatalog} from '../extension/lib/catalog.js';
import {PresetSwitcher, fmt} from '../extension/lib/switcher.js';
import {writeDevices, writePresets} from '../extension/lib/settings.js';

const BS_OUT = 'alsa_output.usb-Acme_USB_Headset-00.analog-stereo';
const BS_IN = 'alsa_input.usb-Acme_USB_Headset-00.mono-fallback';
const PCI = 'alsa_output.pci-0000_00_1f.3.analog-stereo';
const MIC = 'alsa_input.usb-Acme_Studio_Mic_SN0001-00.mono-fallback';
const MAC = 'AA:BB:CC:DD:EE:01';

const PRESETS = [
    {id: 'headphones', name: 'Headphones', output: `output:${BS_OUT}`, input: `input:${BS_IN}`},
    {id: 'speakers', name: 'Speakers', output: `output:${PCI}`, input: `input:${MIC}`},
    {id: 'podcast', name: 'Podcast', output: `output:bt:${MAC}`, input: `input:${MIC}`,
        fallbackOutput: `output:${PCI}`},
];

const wait = ms => new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
    r();
    return GLib.SOURCE_REMOVE;
}));

function setup({presets = PRESETS, btConnected = false} = {}) {
    const s = {
        bsOut: fakeStream(BS_OUT, 'Headphones'),
        bsIn: fakeStream(BS_IN, 'Headset mic'),
        pci: fakeStream(PCI, 'Speakers'),
        mic: fakeStream(MIC, 'Studio Mic'),
    };
    const settings = memorySettings();
    writeDevices(settings, [{direction: 'output', match: {btAddress: MAC}, name: 'Earbuds'}]);
    writePresets(settings, presets);
    const mixer = new FakeMixer({sinks: [s.bsOut, s.pci], sources: [s.bsIn, s.mic]});
    const bluez = new FakeBluez([{address: MAC, name: 'BT Earbuds', paired: true,
        connected: btConnected, hasOutput: true, hasInput: true}]);
    const catalog = new DeviceCatalog({mixer, settings, bluez});
    catalog.start();
    const notes = [];
    const switcher = new PresetSwitcher({catalog, mixer, settings, bluez, timeoutMs: 150,
        notify: (title, body) => notes.push({title, body})});
    return {s, mixer, bluez, catalog, switcher, notes,
        done: () => {
            switcher.destroy();
            catalog.destroy();
        }};
}

test('fmt substitutes in order', () => {
    eq(fmt('%s did not connect in %d seconds', 'Earbuds', 15), 'Earbuds did not connect in 15 seconds');
});

test('devices present: input before output', async () => {
    const t = setup();
    ok(await t.switcher.applyPreset('speakers'));
    eq(t.mixer.calls, [`source:${MIC}`, `sink:${PCI}`]);
    eq(t.switcher.activePresetId, 'speakers');
    eq(t.notes, []);
    t.done();
});

test('BT connected within the timeout', async () => {
    const t = setup();
    t.bluez.onConnect = async () => {
        await wait(30);
        t.mixer.addSink(fakeStream(`bluez_output.${MAC}`, 'BT Earbuds'));
    };
    const p = t.switcher.applyPreset('podcast');
    eq(t.switcher.pending, {kind: 'preset', id: 'podcast'});
    eq(t.mixer.calls, [], 'nothing switched while connecting');
    await p;
    eq(t.bluez.connectCalls, [MAC]);
    eq(t.mixer.calls, [`source:${MIC}`, `sink:bluez_output.${MAC}`]);
    eq(t.switcher.pending, null);
    eq(t.switcher.activePresetId, 'podcast');
    eq(t.notes, []);
    t.done();
});

test('timeout with a fallback output: speakers + notification', async () => {
    const t = setup();
    await t.switcher.applyPreset('podcast');
    eq(t.mixer.calls, [`source:${MIC}`, `sink:${PCI}`]);
    eq(t.notes.length, 1);
    ok(t.notes[0].title.includes('Earbuds'), t.notes[0].title);
    ok(t.notes[0].body.includes('Speakers'), t.notes[0].body);
    // Speakers + mic match both "Speakers" and the fallback pair of "Podcast":
    // per the spec the first preset in order is active.
    eq(t.switcher.activePresetId, 'speakers');
    t.done();
});

test('a fallback pair without competitors counts as active', async () => {
    const t = setup({presets: [PRESETS[2]]});
    await t.switcher.applyPreset('podcast');
    eq(t.switcher.activePresetId, 'podcast');
    t.done();
});

test('timeout without a fallback: nothing changes, error', async () => {
    const t = setup({presets: [{...PRESETS[2], fallbackOutput: null}]});
    await t.switcher.applyPreset('podcast');
    eq(t.mixer.calls, []);
    eq(t.notes.length, 1);
    ok(t.notes[0].title.includes('Podcast'));
    t.done();
});

test('BlueZ error: fallback right away, no waiting for the timeout', async () => {
    const t = setup();
    t.bluez.onConnect = () => Promise.reject(new Error('br-connection-page-timeout'));
    const start = GLib.get_monotonic_time();
    await t.switcher.applyPreset('podcast');
    ok(GLib.get_monotonic_time() - start < 100000, 'did not wait for timeout');
    eq(t.mixer.calls, [`source:${MIC}`, `sink:${PCI}`]);
    ok(t.notes[0].body.includes('br-connection-page-timeout'));
    t.done();
});

test('cancel: a new choice while connecting, a late node does not switch', async () => {
    const t = setup();
    t.bluez.onConnect = () => new Promise(() => {}); // hangs
    const podcast = t.switcher.applyPreset('podcast');
    await wait(20);
    await t.switcher.applyPreset('speakers');
    eq(await podcast, false);
    t.mixer.addSink(fakeStream(`bluez_output.${MAC}`, 'Earbuds'));
    await wait(200);
    eq(t.mixer.calls, [`source:${MIC}`, `sink:${PCI}`]);
    eq(t.notes, []);
    t.done();
});

test('an external device change clears the active preset', async () => {
    const t = setup();
    await t.switcher.applyPreset('headphones');
    eq(t.switcher.activePresetId, 'headphones');
    t.mixer.set_default_sink(t.s.pci); // speakers + headset mic: no such preset
    eq(t.switcher.activePresetId, null);
    t.done();
});

test('picking an input by hand changes only the input', async () => {
    const t = setup();
    await t.switcher.applyPreset('headphones');
    t.mixer.calls.length = 0;
    await t.switcher.selectDevice(`input:${MIC}`);
    eq(t.mixer.calls, [`source:${MIC}`]);
    t.done();
});

test('picking an absent BT device by hand: timeout means only a notification', async () => {
    const t = setup();
    await t.switcher.selectDevice(`output:bt:${MAC}`);
    eq(t.mixer.calls, []);
    eq(t.notes.length, 1);
    t.done();
});

test('a missing wired device: error without waiting', async () => {
    const t = setup();
    t.mixer.removeSink(t.s.bsOut);
    await t.switcher.applyPreset('headphones');
    eq(t.mixer.calls, []);
    ok(t.notes[0].body.includes('not connected'));
    t.done();
});

test('a preset referring to an unknown device', async () => {
    const t = setup({presets: [{id: 'x', name: 'X', output: 'output:nope', input: `input:${MIC}`}]});
    await t.switcher.applyPreset('x');
    eq(t.mixer.calls, []);
    eq(t.notes.length, 1);
    t.done();
});

await run();
