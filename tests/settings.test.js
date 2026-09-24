import GLib from 'gi://GLib';

import {test, eq, ok, run} from './lib/assert.js';
import {memorySettings} from './lib/settings.js';
import * as S from '../extension/lib/settings.js';

const BS = 'alsa_output.usb-Acme_USB_Headset-00.analog-stereo';
const MAC = 'AA:BB:CC:DD:EE:01';

function withWarnings(fn) {
    const warnings = [];
    const orig = S.logger.warn;
    S.logger.warn = msg => warnings.push(String(msg));
    try {
        fn();
    } finally {
        S.logger.warn = orig;
    }
    return warnings;
}

test('empty by default', () => {
    const s = memorySettings();
    eq(S.readDevices(s), []);
    eq(S.readPresets(s), []);
    eq(s.get_uint(S.TIMEOUT_KEY), 15);
});

test('invalid JSON: empty list and a warning', () => {
    const s = memorySettings();
    s.set_string(S.PRESETS_KEY, '{not json');
    let presets;
    const w = withWarnings(() => (presets = S.readPresets(s)));
    eq(presets, []);
    ok(w.some(m => m.includes('presets')), 'warning expected');
});

test('not an array: empty list and a warning', () => {
    const s = memorySettings();
    s.set_string(S.DEVICES_KEY, '{"a":1}');
    const w = withWarnings(() => eq(S.readDevices(s), []));
    eq(w.length, 1);
});

test('devices: round trip without loss, broken entries dropped', () => {
    const s = memorySettings();
    const devices = [
        {direction: 'output', match: {nodeName: BS}, visible: true, name: 'Headphones',
            icon: 'audio-headphones-symbolic', lastDescription: 'Headphones'},
        {direction: 'output', match: {btAddress: 'aa:bb:cc:dd:ee:01'}, visible: false,
            name: '', icon: 'earbuds-symbolic', lastDescription: 'BT Earbuds'},
    ];
    S.writeDevices(s, devices);
    const back = S.readDevices(s);
    eq(back.length, 2);
    eq(back[0].key, `output:${BS}`);
    eq(back[1].key, `output:bt:${MAC}`);
    eq(back[1].visible, false);
    eq(back[0].name, 'Headphones');

    s.set_string(S.DEVICES_KEY, JSON.stringify([...devices,
        {direction: 'sideways', match: {nodeName: 'x'}},
        {direction: 'input', match: {}},
        {direction: 'output', match: {nodeName: BS}}]));
    let read;
    const w = withWarnings(() => (read = S.readDevices(s)));
    eq(read.length, 2, 'invalid and duplicate dropped');
    eq(w.length, 2);
});

test('presets: keys are checked against the direction', () => {
    const s = memorySettings();
    S.writePresets(s, [{
        id: 'podcast', name: 'Podcast',
        output: `output:bt:${MAC}`,
        input: `output:${BS}`, // wrong direction
        fallbackOutput: 'garbage',
    }]);
    const [p] = S.readPresets(s);
    eq(p, {id: 'podcast', name: 'Podcast', output: `output:bt:${MAC}`,
        input: null, fallbackOutput: null});
});

test('a preset without id gets one', () => {
    const p = S.normalizePreset({name: 'X'}, 3);
    ok(p.id.startsWith('preset-3-'));
});

test('writing unchanged data does not touch the key', () => {
    const s = memorySettings();
    let changes = 0;
    s.connect(`changed::${S.PRESETS_KEY}`, () => changes++);
    S.writePresets(s, [{id: 'a', name: 'A'}]);
    S.writePresets(s, [{id: 'a', name: 'A'}]);
    eq(changes, 1);
});

test('Debouncer collapses calls', async () => {
    let calls = 0;
    const d = new S.Debouncer(30, () => calls++);
    d.schedule();
    d.schedule();
    d.schedule();
    await new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 80, () => {
        r();
        return GLib.SOURCE_REMOVE;
    }));
    eq(calls, 1);
    d.schedule();
    d.flush();
    eq(calls, 2);
});

await run();
