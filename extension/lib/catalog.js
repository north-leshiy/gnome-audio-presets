// Device catalog: saved records from GSettings + live Gvc streams + paired
// Bluetooth audio devices from BlueZ. The single source of which devices exist,
// what they are called and which node each one is bound to right now.
import Gvc from 'gi://Gvc';

import {Emitter} from './emitter.js';
import {
    OUTPUT, INPUT, makeKey, parseKey, findNodeName, matchForNodeName, isIgnoredNode,
} from './matching.js';
import {readDevices, writeDevices, normalizeDevice, Debouncer, DEVICES_KEY} from './settings.js';
import {defaultIconFor} from './icons.js';

const WRITE_DELAY_MS = 2000;

/**
 * @typedef {object} CatalogEntry
 * @property {string} key
 * @property {string} direction
 * @property {{nodeName?: string, btAddress?: string}} match
 * @property {boolean} visible
 * @property {string} name          user-defined name ('' when not set)
 * @property {string} icon          icon name ('' for the default)
 * @property {string} lastDescription
 * @property {object|null} stream   Gvc.MixerStream when the node exists
 * @property {boolean} present
 * @property {boolean} bluetooth
 * @property {string} displayName
 * @property {string} iconName
 */

export class DeviceCatalog extends Emitter {
    constructor({mixer, settings, bluez = null}) {
        super();
        this._mixer = mixer;
        this._settings = settings;
        this._bluez = bluez;
        this._entries = new Map();
        this._pending = new Map(); // key -> record to merge on the next write
        this._writer = new Debouncer(WRITE_DELAY_MS, () => this._flushPending());
        this._mixerIds = [];
        this._settingsId = 0;
        this._bluezId = 0;
    }

    start() {
        for (const sig of ['state-changed', 'stream-added', 'stream-removed',
            'default-sink-changed', 'default-source-changed'])
            this._mixerIds.push(this._mixer.connect(sig, () => this.refresh()));
        this._settingsId = this._settings.connect(`changed::${DEVICES_KEY}`,
            () => this.refresh());
        if (this._bluez)
            this._bluezId = this._bluez.connect('changed', () => this.refresh());
        this.refresh();
    }

    destroy() {
        this._writer.flush();
        for (const id of this._mixerIds)
            this._mixer.disconnect(id);
        this._mixerIds = [];
        if (this._settingsId)
            this._settings.disconnect(this._settingsId);
        if (this._bluezId)
            this._bluez.disconnect(this._bluezId);
        this._settingsId = this._bluezId = 0;
        this._entries.clear();
        this.disconnectAll();
    }

    get ready() {
        return this._mixer.get_state() === Gvc.MixerControlState.READY;
    }

    /** @returns {CatalogEntry[]} all devices of a direction, in saved order */
    list(direction) {
        return [...this._entries.values()].filter(e => e.direction === direction);
    }

    /** @returns {CatalogEntry|null} */
    lookup(key) {
        return key ? this._entries.get(key) ?? null : null;
    }

    /** Key of the current default device. */
    defaultKey(direction) {
        const stream = this.defaultStream(direction);
        return stream ? this.keyForStream(stream, direction) : null;
    }

    defaultStream(direction) {
        if (!this.ready)
            return null;
        return direction === OUTPUT
            ? this._mixer.get_default_sink()
            : this._mixer.get_default_source();
    }

    keyForStream(stream, direction) {
        for (const e of this._entries.values()) {
            if (e.direction === direction && e.stream?.id === stream.id)
                return e.key;
        }
        return null;
    }

    refresh() {
        const saved = readDevices(this._settings);
        for (const rec of this._pending.values()) {
            if (!saved.some(s => s.key === rec.key))
                saved.push(rec);
        }

        const streams = {
            [OUTPUT]: this.ready ? this._mixer.get_sinks() : [],
            [INPUT]: this.ready ? this._mixer.get_sources() : [],
        };
        const byName = dir => new Map(streams[dir]
            .filter(s => !isIgnoredNode(s.name))
            .map(s => [s.name, s]));
        const live = {[OUTPUT]: byName(OUTPUT), [INPUT]: byName(INPUT)};
        const claimed = {[OUTPUT]: new Set(), [INPUT]: new Set()};

        const entries = new Map();
        const addEntry = (rec, stream) => {
            const bluetooth = Boolean(rec.match.btAddress);
            const entry = {
                ...rec,
                stream: stream ?? null,
                present: Boolean(stream),
                bluetooth,
                btConnected: bluetooth
                    ? Boolean(this._bluez?.lookup(rec.match.btAddress)?.connected) : false,
            };
            entry.displayName = rec.name || stream?.description || rec.lastDescription || rec.key;
            entry.iconName = rec.icon || defaultIconFor(entry);
            entries.set(rec.key, entry);
            if (stream)
                claimed[rec.direction].add(stream.name);

            if (stream?.description && stream.description !== rec.lastDescription)
                this._remember({...rec, lastDescription: stream.description});
        };

        for (const rec of saved) {
            const name = findNodeName(rec.match, rec.direction, [...live[rec.direction].keys()]
                .filter(n => !claimed[rec.direction].has(n)));
            addEntry(rec, name ? live[rec.direction].get(name) : null);
        }

        for (const dir of [OUTPUT, INPUT]) {
            for (const [name, stream] of live[dir]) {
                if (claimed[dir].has(name))
                    continue;
                const rec = normalizeDevice({
                    direction: dir,
                    match: matchForNodeName(name),
                    visible: true,
                    lastDescription: stream.description ?? '',
                });
                if (!rec || entries.has(rec.key))
                    continue;
                this._remember(rec);
                addEntry(rec, stream);
            }
        }

        for (const dev of this._bluez?.audioDevices ?? []) {
            const dirs = [];
            if (dev.hasOutput)
                dirs.push(OUTPUT);
            if (dev.hasInput)
                dirs.push(INPUT);
            for (const dir of dirs) {
                const key = makeKey(dir, {btAddress: dev.address});
                if (entries.has(key))
                    continue;
                const rec = normalizeDevice({
                    direction: dir, match: {btAddress: dev.address},
                    visible: true, lastDescription: dev.name,
                });
                this._remember(rec);
                addEntry(rec, null);
            }
        }

        this._entries = entries;
        this.emit('changed');
    }

    _remember(rec) {
        this._pending.set(rec.key, rec);
        this._writer.schedule();
    }

    /**
     * Merge with what is in the settings now: prefs may have written its edits
     * while our write was pending, and those must not be overwritten.
     */
    _flushPending() {
        if (!this._pending.size)
            return;
        const current = readDevices(this._settings);
        for (const rec of this._pending.values()) {
            const i = current.findIndex(c => c.key === rec.key);
            if (i < 0)
                current.push(rec);
            else
                current[i] = {...current[i], lastDescription: rec.lastDescription};
        }
        this._pending.clear();
        writeDevices(this._settings, current);
    }
}

export {parseKey};
