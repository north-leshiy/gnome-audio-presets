// Preferences window: presets, and per-device visibility, name and icon.
//
// Gvc is private to the Shell and not available here, so the presence of wired
// devices comes from `pactl -f json` and of Bluetooth devices from BlueZ.
// Every edit re-reads the setting before writing it: the Shell may add newly
// seen devices to the same key at any time.
import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {BluezClient} from './lib/bluez.js';
import {ICONS, giconFor, defaultIconFor} from './lib/icons.js';
import {OUTPUT, INPUT, findNodeName} from './lib/matching.js';
import {
    readDevices, writeDevices, readPresets, writePresets, normalizePreset,
    DEVICES_KEY, PRESETS_KEY, HIDE_NATIVE_KEY
} from './lib/settings.js';

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');

/** Node names per direction from pactl, or null if that fails. */
async function listNodeNames() {
    const run = async kind => {
        const proc = Gio.Subprocess.new(['pactl', '-f', 'json', 'list', 'short', kind],
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        const [stdout] = await proc.communicate_utf8_async(null, null);
        return JSON.parse(stdout).map(n => n.name);
    };
    try {
        return {[OUTPUT]: await run('sinks'), [INPUT]: await run('sources')};
    } catch (e) {
        console.warn(`audio-presets: pactl failed, presence unknown: ${e.message}`);
        return null;
    }
}

function displayName(dev) {
    return dev.name || dev.lastDescription || dev.match.nodeName || dev.match.btAddress;
}

function iconId(dev) {
    return dev.icon || defaultIconFor({...dev, bluetooth: Boolean(dev.match.btAddress)});
}

/** Combo row with icons from the curated set. */
function makeIconRow(currentId, onChange) {
    const ids = ICONS.map(i => i.id);
    const labels = ICONS.map(i => _(i.label));
    const model = Gtk.StringList.new(labels);
    const factory = new Gtk.SignalListItemFactory();
    factory.connect('setup', (f, item) => {
        const box = new Gtk.Box({spacing: 8});
        box.append(new Gtk.Image());
        box.append(new Gtk.Label({xalign: 0}));
        item.set_child(box);
    });
    factory.connect('bind', (f, item) => {
        // For the selected item shown in the row itself, get_position() is not
        // the model position, so look the icon up by label.
        const label = item.get_item().get_string();
        const box = item.get_child();
        box.get_first_child().set_from_gicon(giconFor(ids[labels.indexOf(label)]));
        box.get_last_child().label = label;
    });
    const row = new Adw.ComboRow({title: _('Icon'), model, factory});
    const idx = ids.indexOf(currentId);
    row.selected = idx >= 0 ? idx : Gtk.INVALID_LIST_POSITION;
    row.connect('notify::selected', () => {
        if (row.selected !== Gtk.INVALID_LIST_POSITION)
            onChange(ids[row.selected]);
    });
    return row;
}

class DevicesPage {
    constructor(settings, state) {
        this._settings = settings;
        this._state = state;
        this.widget = new Adw.PreferencesPage({
            title: _('Devices'),
            icon_name: 'audio-speakers-symbolic',
        });
        this._groups = [];
        this._keys = '';
        this.rebuild();
    }

    /** Rebuild only when the set of devices changes, so typing a name is not interrupted. */
    maybeRebuild() {
        const keys = readDevices(this._settings).map(d => d.key).join('\n');
        if (keys !== this._keys)
            this.rebuild();
    }

    rebuild() {
        for (const g of this._groups)
            this.widget.remove(g);
        this._groups = [];
        const devices = readDevices(this._settings);
        this._keys = devices.map(d => d.key).join('\n');

        for (const [direction, title] of [[OUTPUT, _('Outputs')], [INPUT, _('Inputs')]]) {
            const group = new Adw.PreferencesGroup({
                title,
                description: direction === OUTPUT
                    ? _('Hidden devices are not shown in the menu. Names and icons are only used by this extension.')
                    : '',
            });
            for (const dev of devices.filter(d => d.direction === direction))
                group.add(this._deviceRow(dev));
            this.widget.add(group);
            this._groups.push(group);
        }
    }

    _update(key, patch) {
        const list = readDevices(this._settings);
        const dev = list.find(d => d.key === key);
        if (!dev)
            return;
        Object.assign(dev, patch);
        writeDevices(this._settings, list);
    }

    _subtitle(dev) {
        const parts = [];
        if (dev.name && dev.lastDescription && dev.lastDescription !== dev.name)
            parts.push(dev.lastDescription);
        if (!this._state.isPresent(dev))
            parts.push(_('not connected'));
        return parts.join(' · ');
    }

    _deviceRow(dev) {
        const row = new Adw.ExpanderRow({
            title: GLib.markup_escape_text(displayName(dev), -1),
            subtitle: GLib.markup_escape_text(this._subtitle(dev), -1),
        });
        const image = Gtk.Image.new_from_gicon(giconFor(iconId(dev)));
        row.add_prefix(image);

        const visible = new Gtk.Switch({
            active: dev.visible,
            valign: Gtk.Align.CENTER,
            tooltip_text: _('Show in menu'),
        });
        visible.connect('notify::active', () => this._update(dev.key, {visible: visible.active}));
        row.add_suffix(visible);

        const nameRow = new Adw.EntryRow({
            title: _('Name'),
            text: dev.name,
            show_apply_button: true,
        });
        if (dev.lastDescription)
            nameRow.tooltip_text = _('System description: %s').replace('%s', dev.lastDescription);
        nameRow.connect('apply', () => {
            const name = nameRow.text.trim();
            this._update(dev.key, {name});
            row.title = GLib.markup_escape_text(displayName({...dev, name}), -1);
        });
        row.add_row(nameRow);

        row.add_row(makeIconRow(iconId(dev), id => {
            this._update(dev.key, {icon: id});
            image.set_from_gicon(giconFor(id));
        }));

        const systemRow = new Adw.ActionRow({
            title: _('System name'),
            subtitle: GLib.markup_escape_text(
                dev.match.nodeName ?? `Bluetooth ${dev.match.btAddress}`, -1),
            subtitle_selectable: true,
        });
        row.add_row(systemRow);
        return row;
    }
}

class PresetsPage {
    constructor(settings) {
        this._settings = settings;
        this.widget = new Adw.PreferencesPage({
            title: _('Presets'),
            icon_name: 'view-list-symbolic',
        });

        const general = new Adw.PreferencesGroup({title: _('General')});
        const hide = new Adw.SwitchRow({
            title: _('Hide built-in volume icons'),
            subtitle: _('The volume sliders in Quick Settings stay in place'),
        });
        settings.bind(HIDE_NATIVE_KEY, hide, 'active', Gio.SettingsBindFlags.DEFAULT);
        general.add(hide);

        this._group = new Adw.PreferencesGroup({
            title: _('Presets'),
            description: _('A preset switches output and input together. The fallback output is used when the main one does not connect in time.'),
        });
        const add = new Gtk.Button({
            icon_name: 'list-add-symbolic',
            tooltip_text: _('Add preset'),
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        add.connect('clicked', () => this._add());
        this._group.set_header_suffix(add);

        this.widget.add(this._group);
        this.widget.add(general);
        this._rows = [];
        this._expanded = new Set();
        this.rebuild();
    }

    rebuild() {
        for (const r of this._rows)
            this._group.remove(r);
        this._rows = [];
        const presets = readPresets(this._settings);
        const devices = readDevices(this._settings);
        presets.forEach((p, i) => {
            const row = this._presetRow(p, i, presets.length, devices);
            this._group.add(row);
            this._rows.push(row);
        });
        if (!presets.length) {
            const empty = new Adw.ActionRow({
                title: _('No presets yet'),
                subtitle: _('Use the + button to add one'),
            });
            this._group.add(empty);
            this._rows.push(empty);
        }
    }

    _edit(fn) {
        const list = readPresets(this._settings);
        fn(list);
        writePresets(this._settings, list);
    }

    _add() {
        const id = `preset-${GLib.uuid_string_random().slice(0, 8)}`;
        this._expanded.add(id);
        this._edit(list => list.push(normalizePreset({id, name: _('New preset')})));
    }

    _deviceCombo(title, direction, current, devices, {allowNone}) {
        const options = devices.filter(d => d.direction === direction);
        const keys = options.map(d => d.key);
        const labels = options.map(displayName);
        if (allowNone) {
            keys.unshift(null);
            labels.unshift(_('None'));
        }
        if (current && !keys.includes(current)) {
            keys.push(current);
            labels.push(_('Unknown device'));
        }
        const row = new Adw.ComboRow({title, model: Gtk.StringList.new(labels)});
        const idx = keys.indexOf(current ?? null);
        row.selected = idx >= 0 ? idx : Gtk.INVALID_LIST_POSITION;
        return {row, keyAt: i => keys[i]};
    }

    _presetRow(preset, index, count, devices) {
        const row = new Adw.ExpanderRow({
            title: GLib.markup_escape_text(preset.name || _('Unnamed preset'), -1),
            expanded: this._expanded.has(preset.id),
        });
        row.connect('notify::expanded', () => {
            if (row.expanded)
                this._expanded.add(preset.id);
            else
                this._expanded.delete(preset.id);
        });
        const byKey = key => devices.find(d => d.key === key);
        for (const key of [preset.output, preset.input]) {
            const dev = byKey(key);
            row.add_prefix(Gtk.Image.new_from_gicon(
                giconFor(dev ? iconId(dev) : 'dialog-question-symbolic')));
        }

        const setField = (field, value) => this._edit(list => {
            const p = list.find(x => x.id === preset.id);
            if (p)
                p[field] = value;
        });

        const nameRow = new Adw.EntryRow({
            title: _('Name'),
            text: preset.name,
            show_apply_button: true,
        });
        nameRow.connect('apply', () => setField('name', nameRow.text.trim()));
        row.add_row(nameRow);

        for (const [field, title, direction, allowNone] of [
            ['output', _('Output'), OUTPUT, false],
            ['input', _('Input'), INPUT, false],
            ['fallbackOutput', _('Fallback output'), OUTPUT, true],
        ]) {
            const {row: combo, keyAt} = this._deviceCombo(title, direction, preset[field],
                devices, {allowNone});
            combo.connect('notify::selected', () => {
                if (combo.selected !== Gtk.INVALID_LIST_POSITION)
                    setField(field, keyAt(combo.selected));
            });
            row.add_row(combo);
        }

        const actions = new Gtk.Box({
            spacing: 6,
            halign: Gtk.Align.END,
            margin_top: 6,
            margin_bottom: 6,
            margin_end: 6,
        });
        const button = (icon, tooltip, sensitive, cb, extra = []) => {
            const b = new Gtk.Button({
                icon_name: icon,
                tooltip_text: tooltip,
                sensitive,
                css_classes: ['flat', ...extra],
            });
            b.connect('clicked', cb);
            actions.append(b);
        };
        button('go-up-symbolic', _('Move up'), index > 0,
            () => this._edit(list => list.splice(index - 1, 0, ...list.splice(index, 1))));
        button('go-down-symbolic', _('Move down'), index < count - 1,
            () => this._edit(list => list.splice(index + 1, 0, ...list.splice(index, 1))));
        button('user-trash-symbolic', _('Delete preset'), true,
            () => this._edit(list => list.splice(index, 1)), ['destructive-action']);
        row.add_row(new Adw.PreferencesRow({activatable: false, child: actions}));
        return row;
    }
}

export default class AudioPresetsPreferences extends ExtensionPreferences {
    async fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const bluez = new BluezClient();
        const state = {
            nodes: null,
            isPresent(dev) {
                if (dev.match.btAddress)
                    return Boolean(bluez.lookup(dev.match.btAddress)?.connected);
                if (!this.nodes)
                    return true; // unknown, do not mark as disconnected
                return Boolean(findNodeName(dev.match, dev.direction, this.nodes[dev.direction]));
            },
        };

        const devicesPage = new DevicesPage(settings, state);
        const presetsPage = new PresetsPage(settings);
        window.add(presetsPage.widget);
        window.add(devicesPage.widget);
        window.set_default_size(620, 720);

        const ids = [
            settings.connect(`changed::${DEVICES_KEY}`, () => {
                devicesPage.maybeRebuild();
                presetsPage.rebuild();
            }),
            settings.connect(`changed::${PRESETS_KEY}`, () => presetsPage.rebuild()),
        ];
        // BlueZ sends PropertiesChanged often (e.g. RSSI while scanning), so
        // rebuild the page only when a connection state changes.
        const btSignature = () => bluez.audioDevices.map(d => `${d.address}:${d.connected}`).join();
        let lastBt = '';
        const bluezId = bluez.connect('changed', () => {
            const sig = btSignature();
            if (sig !== lastBt) {
                lastBt = sig;
                devicesPage.rebuild();
            }
        });
        let closed = false;
        window.connect('close-request', () => {
            closed = true;
            ids.forEach(id => settings.disconnect(id));
            bluez.disconnect(bluezId);
            bluez.destroy();
            return false;
        });

        await bluez.start();
        if (closed)
            return;
        state.nodes = await listNodeNames();
        if (!closed)
            devicesPage.rebuild();
    }
}
