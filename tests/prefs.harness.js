// Preset editor check without clicks: prefs.js is loaded into this process,
// buttons are pressed through the widget tree, settings are kept in memory.
// No window is shown, but GTK needs a display, so use a running devkit:
//   GSETTINGS_BACKEND=memory LANGUAGE=en WAYLAND_DISPLAY=wayland-1 gjs -m tests/prefs.harness.js
import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {test, eq, ok, run} from './lib/assert.js';

if (GLib.getenv('GSETTINGS_BACKEND') !== 'memory')
    throw new Error('refusing to run without GSETTINGS_BACKEND=memory');

Gio.Resource.load('/usr/share/gnome-shell/org.gnome.Shell.Extensions.src.gresource')._register();
const extDir = Gio.File.new_for_uri(import.meta.url).get_parent().get_parent().get_child('extension');
const metadata = JSON.parse(new TextDecoder().decode(
    extDir.get_child('metadata.json').load_contents(null)[1]));
metadata.dir = extDir;
metadata.path = extDir.get_path();

const {default: Prefs} = await import('../extension/prefs.js');
const {ExtensionPreferences} = await import(
    'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js');
Adw.init();

const prefs = new Prefs(metadata);
// The real app finds the extension by the UUID directory in the module path;
// here the module lives in extension/, so tell the gettext wrapper explicitly.
ExtensionPreferences.lookupByURL = () => prefs;
const settings = prefs.getSettings();
const window = new Adw.PreferencesWindow();
await prefs.fillPreferencesWindow(window);

const readPresets = () => JSON.parse(settings.get_string('presets'));

function* walk(w) {
    yield w;
    for (let c = w.get_first_child(); c; c = c.get_next_sibling())
        yield* walk(c);
}
const all = pred => [...walk(window)].filter(pred);
const buttons = tip => all(w => w instanceof Gtk.Button && w.tooltip_text === tip);

const BS_OUT = 'output:alsa_output.usb-Acme_USB_Headset-00.analog-stereo';
const PCI_OUT = 'output:alsa_output.pci-0000_00_1f.3.analog-stereo';
settings.set_string('devices', JSON.stringify([
    {direction: 'output', match: {nodeName: BS_OUT.slice(7)}, name: 'Headphones'},
    {direction: 'output', match: {nodeName: PCI_OUT.slice(7)}, name: 'Speakers'},
]));

test('empty: hint row and + button', () => {
    eq(readPresets(), []);
    ok(all(w => w instanceof Adw.ActionRow && w.title === 'No presets yet').length === 1);
    eq(buttons('Add preset').length, 1);
});

test('+ adds a preset', () => {
    buttons('Add preset')[0].emit('clicked');
    const p = readPresets();
    eq(p.length, 1);
    eq(p[0].name, 'New preset');
});

test('choosing an output in the ComboRow stores its key', () => {
    const combo = all(w => w instanceof Adw.ComboRow && w.title === 'Output')[0];
    const labels = [...Array(combo.model.get_n_items()).keys()].map(i => combo.model.get_string(i));
    eq(labels, ['Headphones', 'Speakers']);
    combo.selected = 1;
    eq(readPresets()[0].output, PCI_OUT);
});

test('fallback output: "None" is the first entry', () => {
    const combo = all(w => w instanceof Adw.ComboRow && w.title === 'Fallback output')[0];
    eq(combo.model.get_string(0), 'None');
    combo.selected = 1;
    eq(readPresets()[0].fallbackOutput, BS_OUT);
    all(w => w instanceof Adw.ComboRow && w.title === 'Fallback output')[0].selected = 0;
    eq(readPresets()[0].fallbackOutput, null);
});

test('renaming through EntryRow apply', () => {
    const entry = all(w => w instanceof Adw.EntryRow && w.title === 'Name' && w.text === 'New preset')[0];
    entry.text = 'Speakers preset';
    entry.emit('apply');
    eq(readPresets()[0].name, 'Speakers preset');
});

test('order: down, up; edge buttons are insensitive', () => {
    settings.set_string('presets', JSON.stringify([
        {id: 'a', name: 'A'}, {id: 'b', name: 'B'}, {id: 'c', name: 'C'}]));
    const down = buttons('Move down');
    const up = buttons('Move up');
    eq(up.map(b => b.sensitive), [false, true, true]);
    eq(down.map(b => b.sensitive), [true, true, false]);
    down[0].emit('clicked');
    eq(readPresets().map(p => p.id), ['b', 'a', 'c']);
    buttons('Move up')[2].emit('clicked');
    eq(readPresets().map(p => p.id), ['b', 'c', 'a']);
});

test('delete', () => {
    buttons('Delete preset')[1].emit('clicked');
    eq(readPresets().map(p => p.id), ['b', 'a']);
});

test('a reference to an unknown device shows as "Unknown device"', () => {
    settings.set_string('presets', JSON.stringify([{id: 'x', name: 'X', output: 'output:nope'}]));
    const combo = all(w => w instanceof Adw.ComboRow && w.title === 'Output')[0];
    eq(combo.model.get_string(combo.selected), 'Unknown device');
});

const readDevice = key => JSON.parse(settings.get_string('devices'))
    .find(d => `${d.direction}:${d.match.nodeName}` === key);

test('device: name, icon and visibility are written to settings', () => {
    const name = all(w => w instanceof Adw.EntryRow && w.title === 'Name' && w.text === 'Speakers')[0];
    name.text = 'Speakers';
    name.emit('apply');
    eq(readDevice(PCI_OUT).name, 'Speakers');

    const expander = name.get_ancestor(Adw.ExpanderRow);
    const icon = [...walk(expander)].find(w => w instanceof Adw.ComboRow && w.title === 'Icon');
    icon.selected = 3; // audio-speaker-cabinet-symbolic
    eq(readDevice(PCI_OUT).icon, 'audio-speaker-cabinet-symbolic');

    const sw = [...walk(expander)].find(w => w instanceof Gtk.Switch);
    sw.active = false;
    eq(readDevice(PCI_OUT).visible, false);
    eq(readDevice(BS_OUT).visible, true, 'other device untouched');
});

await run();
window.destroy();
