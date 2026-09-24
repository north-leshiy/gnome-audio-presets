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
    {id: 'headphones', name: 'Наушники', output: `output:${BS_OUT}`, input: `input:${BS_IN}`},
    {id: 'speakers', name: 'Колонки', output: `output:${PCI}`, input: `input:${MIC}`},
    {id: 'podcast', name: 'Подкаст', output: `output:bt:${MAC}`, input: `input:${MIC}`,
        fallbackOutput: `output:${PCI}`},
];

const wait = ms => new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
    r();
    return GLib.SOURCE_REMOVE;
}));

function setup({presets = PRESETS, btConnected = false} = {}) {
    const s = {
        bsOut: fakeStream(BS_OUT, 'Наушники'),
        bsIn: fakeStream(BS_IN, 'Микрофон (Наушники)'),
        pci: fakeStream(PCI, 'Колонки'),
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

test('fmt подставляет по порядку', () => {
    eq(fmt('%s did not connect in %d seconds', 'Earbuds', 15), 'Earbuds did not connect in 15 seconds');
});

test('устройства присутствуют: вход раньше выхода', async () => {
    const t = setup();
    ok(await t.switcher.applyPreset('speakers'));
    eq(t.mixer.calls, [`source:${MIC}`, `sink:${PCI}`]);
    eq(t.switcher.activePresetId, 'speakers');
    eq(t.notes, []);
    t.done();
});

test('BT подключился в пределах таймаута', async () => {
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

test('таймаут с запасным выходом: колонки + уведомление', async () => {
    const t = setup();
    await t.switcher.applyPreset('podcast');
    eq(t.mixer.calls, [`source:${MIC}`, `sink:${PCI}`]);
    eq(t.notes.length, 1);
    ok(t.notes[0].title.includes('Earbuds'), t.notes[0].title);
    ok(t.notes[0].body.includes('Колонки'), t.notes[0].body);
    // Колонки+микрофон совпадают и с «Колонками», и с запасной парой «Подкаста»:
    // по спеке активен первый по порядку.
    eq(t.switcher.activePresetId, 'speakers');
    t.done();
});

test('запасная пара без конкурентов считается активной', async () => {
    const t = setup({presets: [PRESETS[2]]});
    await t.switcher.applyPreset('podcast');
    eq(t.switcher.activePresetId, 'podcast');
    t.done();
});

test('таймаут без запасного: ничего не меняем, ошибка', async () => {
    const t = setup({presets: [{...PRESETS[2], fallbackOutput: null}]});
    await t.switcher.applyPreset('podcast');
    eq(t.mixer.calls, []);
    eq(t.notes.length, 1);
    ok(t.notes[0].title.includes('Подкаст'));
    t.done();
});

test('ошибка BlueZ — сразу запасной, без ожидания таймаута', async () => {
    const t = setup();
    t.bluez.onConnect = () => Promise.reject(new Error('br-connection-page-timeout'));
    const start = GLib.get_monotonic_time();
    await t.switcher.applyPreset('podcast');
    ok(GLib.get_monotonic_time() - start < 100000, 'did not wait for timeout');
    eq(t.mixer.calls, [`source:${MIC}`, `sink:${PCI}`]);
    ok(t.notes[0].body.includes('br-connection-page-timeout'));
    t.done();
});

test('отмена: новый выбор во время подключения, поздняя нода не переключает', async () => {
    const t = setup();
    t.bluez.onConnect = () => new Promise(() => {}); // висит
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

test('внешняя смена устройства снимает активный пресет', async () => {
    const t = setup();
    await t.switcher.applyPreset('headphones');
    eq(t.switcher.activePresetId, 'headphones');
    t.mixer.set_default_sink(t.s.pci); // Колонки + микрофон гарнитуры — нет такого пресета
    eq(t.switcher.activePresetId, null);
    t.done();
});

test('ручной выбор входа меняет только вход', async () => {
    const t = setup();
    await t.switcher.applyPreset('headphones');
    t.mixer.calls.length = 0;
    await t.switcher.selectDevice(`input:${MIC}`);
    eq(t.mixer.calls, [`source:${MIC}`]);
    t.done();
});

test('ручной выбор отсутствующего BT: таймаут — только уведомление', async () => {
    const t = setup();
    await t.switcher.selectDevice(`output:bt:${MAC}`);
    eq(t.mixer.calls, []);
    eq(t.notes.length, 1);
    t.done();
});

test('отсутствующее проводное устройство: ошибка без ожидания', async () => {
    const t = setup();
    t.mixer.removeSink(t.s.bsOut);
    await t.switcher.applyPreset('headphones');
    eq(t.mixer.calls, []);
    ok(t.notes[0].body.includes('not connected'));
    t.done();
});

test('пресет со ссылкой на неизвестное устройство', async () => {
    const t = setup({presets: [{id: 'x', name: 'X', output: 'output:nope', input: `input:${MIC}`}]});
    await t.switcher.applyPreset('x');
    eq(t.mixer.calls, []);
    eq(t.notes.length, 1);
    t.done();
});

await run();
