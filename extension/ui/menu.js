// Popup menu content: preset tiles, device tiles and volume sliders.
// The tiles are few, so they are rebuilt on every catalog or preset change.
import Clutter from 'gi://Clutter';
import St from 'gi://St';

import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {OUTPUT, INPUT} from '../lib/matching.js';
import {giconFor} from '../lib/icons.js';
import {StreamSlider} from './streamSlider.js';

const PER_ROW = 3;
const ABSENT_OPACITY = 110;
const UNKNOWN_ICON = 'dialog-question-symbolic';

function iconFor(entry) {
    return new St.Icon({
        gicon: giconFor(entry?.iconName ?? UNKNOWN_ICON),
        style_class: 'audio-presets-icon',
    });
}

/**
 * Lays out actors in rows of PER_ROW equal cells. finish() pads the last row
 * with empty cells, so a lone tile does not take the whole width.
 */
function makeGrid(parent) {
    let row = null;
    let count = 0;
    const add = actor => {
        if (!row || count % PER_ROW === 0) {
            row = new St.BoxLayout({style_class: 'audio-presets-row', x_expand: true});
            row.layout_manager.homogeneous = true;
            parent.add_child(row);
        }
        row.add_child(actor);
        count++;
    };
    const finish = () => {
        while (row && count % PER_ROW !== 0) {
            row.add_child(new St.Widget({x_expand: true}));
            count++;
        }
    };
    return {add, finish};
}

function makeTile({icons, label, checked, pending, dim, onClick, accessibleName}) {
    const content = new St.BoxLayout({
        orientation: Clutter.Orientation.VERTICAL,
        x_align: Clutter.ActorAlign.CENTER,
    });
    const iconRow = new St.BoxLayout({x_align: Clutter.ActorAlign.CENTER});
    icons.forEach((icon, i) => {
        if (i > 0) {
            iconRow.add_child(new St.Label({
                text: '/',
                style_class: 'audio-presets-slash',
                y_align: Clutter.ActorAlign.CENTER,
            }));
        }
        iconRow.add_child(icon);
    });
    content.add_child(iconRow);
    content.add_child(new St.Label({
        text: pending ? `${label}…` : label,
        style_class: 'audio-presets-tile-label',
        x_align: Clutter.ActorAlign.CENTER,
    }));

    const button = new St.Button({
        child: content,
        style_class: 'audio-presets-tile',
        can_focus: true,
        x_expand: true,
        checked,
        accessible_name: accessibleName ?? label,
    });
    if (pending)
        button.add_style_class_name('audio-presets-pending');
    if (dim)
        content.opacity = ABSENT_OPACITY;
    button.connect('clicked', onClick);
    return button;
}

export class AudioMenu {
    constructor(menu, {catalog, switcher, mixer, openPreferences}) {
        this._menu = menu;
        this._catalog = catalog;
        this._switcher = switcher;
        this._mixer = mixer;
        this._openPreferences = openPreferences;

        menu.box.add_style_class_name('audio-presets-menu');

        this._presetItem = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        this._presetBox = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        this._presetItem.add_child(this._presetBox);
        menu.addMenuItem(this._presetItem);

        this._emptyItem = new PopupMenu.PopupMenuItem(_('No presets yet. Open settings to add one.'));
        this._emptyItem.connect('activate', () => this._openPreferences());
        menu.addMenuItem(this._emptyItem);

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(_('Output')));
        this._outputTiles = this._addTileSection();
        this.outputSlider = new StreamSlider(mixer, OUTPUT);
        menu.addMenuItem(this.outputSlider);

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(_('Input')));
        this._inputTiles = this._addTileSection();
        this._inputSlider = new StreamSlider(mixer, INPUT);
        menu.addMenuItem(this._inputSlider);

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        menu.addAction(_('Audio Presets Settings'), () => this._openPreferences());

        this._ids = [
            [catalog, catalog.connect('changed', () => this.sync())],
            [switcher, switcher.connect('changed', () => this.sync())],
            [switcher, switcher.connect('pending-changed', () => this.sync())],
        ];
        this.sync();
    }

    /** Disconnects from the models; the menu items are destroyed with the menu. */
    destroy() {
        for (const [obj, id] of this._ids)
            obj.disconnect(id);
        this._ids = [];
    }

    _addTileSection() {
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        item.add_child(box);
        this._menu.addMenuItem(item);
        return box;
    }

    sync() {
        this._syncPresets();
        this._syncTiles(OUTPUT, this._outputTiles);
        this._syncTiles(INPUT, this._inputTiles);
        this._syncSlider(OUTPUT, this.outputSlider);
        this._syncSlider(INPUT, this._inputSlider);
    }

    _syncPresets() {
        this._presetBox.destroy_all_children();
        const presets = this._switcher.presets;
        this._presetItem.visible = presets.length > 0;
        this._emptyItem.visible = presets.length === 0;

        const active = this._switcher.activePresetId;
        const pending = this._switcher.pending;
        const {add, finish} = makeGrid(this._presetBox);
        for (const p of presets) {
            const out = this._catalog.lookup(p.output);
            const inp = this._catalog.lookup(p.input);
            add(makeTile({
                icons: [iconFor(out), iconFor(inp)],
                label: p.name || _('Unnamed preset'),
                checked: p.id === active,
                pending: pending?.kind === 'preset' && pending.id === p.id,
                dim: false,
                onClick: () => this._switcher.applyPreset(p.id),
            }));
        }
        finish();
    }

    _syncTiles(direction, box) {
        box.destroy_all_children();
        const current = this._catalog.defaultKey(direction);
        const pending = this._switcher.pending;
        const {add, finish} = makeGrid(box);
        let shown = 0;
        for (const e of this._catalog.list(direction)) {
            if (!e.visible || (!e.present && !e.bluetooth))
                continue;
            shown++;
            add(makeTile({
                icons: [iconFor(e)],
                label: e.displayName,
                checked: e.key === current,
                pending: pending?.kind === 'device' && pending.id === e.key,
                dim: !e.present,
                accessibleName: e.present ? e.displayName
                    : `${e.displayName} (${_('not connected')})`,
                onClick: () => this._switcher.selectDevice(e.key),
            }));
        }
        finish();
        box.get_parent().visible = shown > 0;
    }

    _syncSlider(direction, slider) {
        const stream = this._catalog.defaultStream(direction);
        slider.stream = stream;
        const entry = this._catalog.lookup(this._catalog.defaultKey(direction));
        slider.setName(entry?.displayName ?? stream?.description ?? '');
    }
}
