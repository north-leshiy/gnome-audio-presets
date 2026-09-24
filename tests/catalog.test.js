import GLib from 'gi://GLib';

import {test, eq, ok, run} from './lib/assert.js';
import {memorySettings} from './lib/settings.js';
import {FakeMixer, FakeBluez, fakeStream} from './lib/fakes.js';
import {DeviceCatalog} from '../extension/lib/catalog.js';
import {readDevices, writeDevices} from '../extension/lib/settings.js';

const BS = 'alsa_output.usb-Acme_USB_Headset-00.analog-stereo';
const PCI = 'alsa_output.pci-0000_00_1f.3.analog-stereo';
const MIC = 'alsa_input.usb-Acme_Studio_Mic_SN0001-00.mono-fallback';
const MAC = 'AA:BB:CC:DD:EE:01';

const wait = ms => new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
    r();
    return GLib.SOURCE_REMOVE;
}));

function setup({sinks = [], sources = [], bt = [], saved = []} = {}) {
    const settings = memorySettings();
    writeDevices(settings, saved);
    const mixer = new FakeMixer({sinks, sources});
    const bluez = new FakeBluez(bt);
    const catalog = new DeviceCatalog({mixer, settings, bluez});
    catalog.start();
    return {settings, mixer, bluez, catalog};
}

test('живые ноды попадают в каталог и запоминаются', () => {
    const {catalog, settings} = setup({
        sinks: [fakeStream(BS, 'Наушники'), fakeStream(`${BS}.monitor`)],
        sources: [fakeStream(MIC, 'Studio Mic Mono')],
    });
    eq(catalog.list('output').map(e => e.key), [`output:${BS}`]);
    eq(catalog.list('input')[0].displayName, 'Studio Mic Mono');
    catalog.destroy(); // flush
    eq(readDevices(settings).map(d => d.key), [`output:${BS}`, `input:${MIC}`]);
});

test('переподключение с новым id и суффиксом — то же устройство', () => {
    const {catalog, mixer} = setup({
        saved: [{direction: 'output', match: {nodeName: BS}, name: 'Наушники',
            icon: 'audio-headphones-symbolic'}],
    });
    eq(catalog.lookup(`output:${BS}`).present, false);
    const s = fakeStream('alsa_output.usb-Acme_USB_Headset-00.7.analog-stereo', 'X');
    mixer.addSink(s);
    const e = catalog.lookup(`output:${BS}`);
    eq(e.present, true);
    eq(e.stream.id, s.id);
    eq(e.displayName, 'Наушники');
    eq(catalog.list('output').length, 1, 'no duplicate entry for suffixed node');
    catalog.destroy();
});

test('отключённое USB-устройство остаётся, но отсутствует', () => {
    const s = fakeStream(BS, 'Наушники');
    const {catalog, mixer} = setup({sinks: [s]});
    mixer.removeSink(s);
    const e = catalog.lookup(`output:${BS}`);
    ok(e && !e.present);
    eq(e.displayName, 'Наушники', 'falls back to lastDescription');
    catalog.destroy();
});

test('привязанные BT без нод: выход и вход', () => {
    const {catalog} = setup({bt: [{address: MAC, name: 'BT Earbuds', paired: true,
        connected: false, hasOutput: true, hasInput: true}]});
    const out = catalog.lookup(`output:bt:${MAC}`);
    const inp = catalog.lookup(`input:bt:${MAC}`);
    ok(out && inp);
    eq(out.present, false);
    eq(out.bluetooth, true);
    eq(out.displayName, 'BT Earbuds');
    catalog.destroy();
});

test('BT-нода появилась — устройство присутствует, internal не дублируется', () => {
    const {catalog, mixer} = setup({bt: [{address: MAC, name: 'Earbuds', paired: true,
        connected: true, hasOutput: true, hasInput: false}]});
    mixer.addSink(fakeStream('bluez_output_internal.AA_BB_CC_DD_EE_01.1'));
    mixer.addSink(fakeStream(`bluez_output.${MAC}`, 'BT Earbuds'));
    eq(catalog.list('output').map(e => e.key), [`output:bt:${MAC}`]);
    eq(catalog.lookup(`output:bt:${MAC}`).present, true);
    catalog.destroy();
});

test('пользовательское имя и иконка важнее системных', () => {
    const {catalog} = setup({
        sinks: [fakeStream(PCI, 'Линейный выход')],
        saved: [{direction: 'output', match: {nodeName: PCI}, name: 'Колонки',
            icon: 'audio-speaker-cabinet-symbolic'}],
    });
    const e = catalog.lookup(`output:${PCI}`);
    eq(e.displayName, 'Колонки');
    eq(e.iconName, 'audio-speaker-cabinet-symbolic');
    catalog.destroy();
});

test('defaultKey по текущему default sink', () => {
    const a = fakeStream(BS);
    const b = fakeStream(PCI);
    const {catalog, mixer} = setup({sinks: [a, b]});
    eq(catalog.defaultKey('output'), `output:${BS}`);
    mixer.set_default_sink(b);
    eq(catalog.defaultKey('output'), `output:${PCI}`);
    catalog.destroy();
});

test('автозапоминание не затирает правки prefs, сделанные во время ожидания', async () => {
    const {catalog, settings, mixer} = setup({
        saved: [{direction: 'output', match: {nodeName: PCI}, lastDescription: 'Колонки'}],
    });
    mixer.addSink(fakeStream(BS, 'Наушники')); // запланирована запись
    // prefs тем временем переименовал колонки
    writeDevices(settings, [{direction: 'output', match: {nodeName: PCI}, name: 'Мои колонки'}]);
    await wait(2200);
    const devs = readDevices(settings);
    eq(devs.find(d => d.key === `output:${PCI}`).name, 'Мои колонки');
    ok(devs.some(d => d.key === `output:${BS}`));
    catalog.destroy();
});

await run();
