// Reading and writing the JSON keys in GSettings. Shared by the Shell, prefs and
// tests: imports only GLib, the Gio.Settings object is passed in.
import GLib from 'gi://GLib';

import {OUTPUT, INPUT, makeKey, parseKey, normalizeMac} from './matching.js';

export const DEVICES_KEY = 'devices';
export const PRESETS_KEY = 'presets';
export const TIMEOUT_KEY = 'bt-connect-timeout';
export const HIDE_NATIVE_KEY = 'hide-native-indicators';

// Replaced in tests: console.warn is read-only in gjs.
export const logger = {warn: msg => console.warn(msg)};

const str = v => (typeof v === 'string' ? v : '');

function parseArray(settings, key) {
    const raw = settings.get_string(key);
    try {
        const value = JSON.parse(raw);
        if (Array.isArray(value))
            return value;
        logger.warn(`audio-presets: ${key} is not a JSON array, ignoring`);
    } catch (e) {
        logger.warn(`audio-presets: ${key} is not valid JSON, ignoring: ${e.message}`);
    }
    return [];
}

/**
 * Bring a device record into canonical form, or return null.
 * The key is always recomputed from direction+match; the stored one is not trusted.
 */
export function normalizeDevice(obj) {
    if (!obj || typeof obj !== 'object')
        return null;
    const direction = obj.direction;
    if (direction !== OUTPUT && direction !== INPUT)
        return null;

    let match = null;
    if (obj.match?.btAddress) {
        const btAddress = normalizeMac(obj.match.btAddress);
        if (btAddress)
            match = {btAddress};
    } else if (typeof obj.match?.nodeName === 'string' && obj.match.nodeName) {
        match = {nodeName: obj.match.nodeName};
    }
    if (!match)
        return null;

    return {
        key: makeKey(direction, match),
        direction,
        match,
        visible: obj.visible !== false,
        name: str(obj.name),
        icon: str(obj.icon),
        lastDescription: str(obj.lastDescription),
    };
}

const validKeyOrNull = (key, direction) => {
    const parsed = parseKey(key);
    return parsed && parsed.direction === direction ? key : null;
};

export function normalizePreset(obj, index = 0) {
    if (!obj || typeof obj !== 'object')
        return null;
    return {
        id: str(obj.id) || `preset-${index}-${GLib.uuid_string_random().slice(0, 8)}`,
        name: str(obj.name),
        output: validKeyOrNull(obj.output, OUTPUT),
        input: validKeyOrNull(obj.input, INPUT),
        fallbackOutput: validKeyOrNull(obj.fallbackOutput, OUTPUT),
    };
}

function readList(settings, key, normalize) {
    const out = [];
    const seen = new Set();
    parseArray(settings, key).forEach((item, i) => {
        const norm = normalize(item, i);
        if (!norm) {
            logger.warn(`audio-presets: dropping invalid ${key} entry #${i}: ${JSON.stringify(item)}`);
            return;
        }
        const id = norm.key ?? norm.id;
        if (seen.has(id))
            return;
        seen.add(id);
        out.push(norm);
    });
    return out;
}

export function readDevices(settings) {
    return readList(settings, DEVICES_KEY, normalizeDevice);
}

export function readPresets(settings) {
    return readList(settings, PRESETS_KEY, normalizePreset);
}

function writeIfChanged(settings, key, value) {
    const json = JSON.stringify(value);
    if (settings.get_string(key) !== json)
        settings.set_string(key, json);
}

export function writeDevices(settings, devices) {
    writeIfChanged(settings, DEVICES_KEY, devices.map(normalizeDevice).filter(Boolean));
}

export function writePresets(settings, presets) {
    writeIfChanged(settings, PRESETS_KEY, presets.map(normalizePreset).filter(Boolean));
}

/** Deferred call: repeated schedule() calls within the delay collapse into one. */
export class Debouncer {
    constructor(delayMs, fn) {
        this._delay = delayMs;
        this._fn = fn;
        this._id = 0;
    }

    schedule() {
        if (this._id)
            GLib.source_remove(this._id);
        this._id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this._delay, () => {
            this._id = 0;
            this._fn();
            return GLib.SOURCE_REMOVE;
        });
    }

    /** Run the pending call now (e.g. in disable()). */
    flush() {
        if (!this._id)
            return;
        GLib.source_remove(this._id);
        this._id = 0;
        this._fn();
    }

    cancel() {
        if (this._id)
            GLib.source_remove(this._id);
        this._id = 0;
    }
}
