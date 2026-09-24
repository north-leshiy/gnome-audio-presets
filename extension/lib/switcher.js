// Применение пресетов и ручной выбор устройства.
//
// Каждое применение — «операция» со своим Gio.Cancellable; новая операция
// отменяет предыдущую, и отменённая уже ничего не переключает. Если нужное
// Bluetooth-устройство не подключено, просим BlueZ подключить его и ждём
// появления ноды в каталоге не дольше таймаута.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {Emitter} from './emitter.js';
import {OUTPUT, INPUT} from './matching.js';
import {readPresets, PRESETS_KEY, TIMEOUT_KEY} from './settings.js';

/** printf-подстановка %s/%d по порядку; String.prototype.format есть только в Shell. */
export function fmt(str, ...args) {
    let i = 0;
    return str.replace(/%[sd]/g, () => String(args[i++]));
}

class SwitchError extends Error {}

function isCancelled(e) {
    return e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}

const cancelledError = () =>
    new GLib.Error(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED, 'cancelled');

// Ответы BlueZ, после которых подключение всё равно может завершиться.
const BENIGN_CONNECT_ERRORS = /InProgress|AlreadyConnected|AlreadyExists/;

export class PresetSwitcher extends Emitter {
    /**
     * @param {object} params
     * @param {import('./catalog.js').DeviceCatalog} params.catalog
     * @param {object} params.mixer          Gvc.MixerControl
     * @param {object} params.settings       Gio.Settings расширения
     * @param {object|null} params.bluez     BluezClient
     * @param {Function} params.notify       (title, body) => void
     * @param {Function} [params.gettext]
     * @param {number} [params.timeoutMs]    переопределение для тестов
     */
    constructor({catalog, mixer, settings, bluez, notify, gettext = s => s, timeoutMs = null}) {
        super();
        this._catalog = catalog;
        this._mixer = mixer;
        this._settings = settings;
        this._bluez = bluez;
        this._notify = notify;
        this._ = gettext;
        this._timeoutOverride = timeoutMs;
        this._op = null;
        this._presets = readPresets(settings);
        this._ids = [
            [settings, settings.connect(`changed::${PRESETS_KEY}`, () => {
                this._presets = readPresets(settings);
                this.emit('changed');
            })],
            [catalog, catalog.connect('changed', () => this.emit('changed'))],
        ];
    }

    destroy() {
        this._op?.cancellable.cancel();
        this._op = null;
        for (const [obj, id] of this._ids)
            obj.disconnect(id);
        this._ids = [];
        this.disconnectAll();
    }

    get presets() {
        return this._presets;
    }

    /** Что сейчас применяется: {kind: 'preset'|'device', id} или null. */
    get pending() {
        return this._op ? {kind: this._op.kind, id: this._op.id} : null;
    }

    /** id первого пресета, чья пара совпадает с текущими default. */
    get activePresetId() {
        const out = this._catalog.defaultKey(OUTPUT);
        const inp = this._catalog.defaultKey(INPUT);
        if (!out || !inp)
            return null;
        const hit = this._presets.find(p => p.input === inp &&
            (p.output === out || (p.fallbackOutput && p.fallbackOutput === out)));
        return hit?.id ?? null;
    }

    get _timeoutMs() {
        return this._timeoutOverride ?? this._settings.get_uint(TIMEOUT_KEY) * 1000;
    }

    applyPreset(id) {
        const preset = this._presets.find(p => p.id === id);
        if (!preset)
            return Promise.resolve(false);
        return this._run('preset', id, op => this._doPreset(preset, op));
    }

    selectDevice(key) {
        return this._run('device', key, op => this._doDevice(key, op));
    }

    async _run(kind, id, body) {
        this._op?.cancellable.cancel();
        const op = {kind, id, cancellable: new Gio.Cancellable()};
        this._op = op;
        this.emit('pending-changed');
        try {
            await body(op);
            return true;
        } catch (e) {
            if (!isCancelled(e))
                logError(e, 'audio-presets: switch failed');
            return false;
        } finally {
            if (this._op === op) {
                this._op = null;
                this.emit('pending-changed');
            }
        }
    }

    async _doPreset(preset, op) {
        const _ = this._;
        const title = fmt(_('Could not apply “%s”'), preset.name);
        const out = this._catalog.lookup(preset.output);
        const inp = this._catalog.lookup(preset.input);
        if (!out || !inp) {
            this._notify(title, _('The preset refers to a device that is not known.'));
            return;
        }

        try {
            await this._ensurePresent([inp, out], op);
            this._setDefaults(out.key, inp.key);
            return;
        } catch (e) {
            if (isCancelled(e) || !(e instanceof SwitchError))
                throw e;
            // Вход недоступен — запасной выход не поможет.
            if (!this._catalog.lookup(inp.key)?.present) {
                this._notify(title, e.message);
                return;
            }
            const fb = this._catalog.lookup(preset.fallbackOutput);
            if (fb?.present) {
                this._setDefaults(fb.key, inp.key);
                this._notify(fmt(_('%s is not available'), out.displayName),
                    fmt(_('%s. Switched to %s instead.'), e.message, fb.displayName));
                return;
            }
            this._notify(title, e.message);
        }
    }

    async _doDevice(key, op) {
        const entry = this._catalog.lookup(key);
        if (!entry)
            return;
        try {
            await this._ensurePresent([entry], op);
        } catch (e) {
            if (e instanceof SwitchError) {
                this._notify(fmt(this._('Could not switch to %s'), entry.displayName), e.message);
                return;
            }
            throw e;
        }
        if (entry.direction === OUTPUT)
            this._setDefaults(key, null);
        else
            this._setDefaults(null, key);
    }

    /** Вход ставим раньше выхода: так BT-наушники не уходят в режим гарнитуры. */
    _setDefaults(outKey, inKey) {
        const inp = this._catalog.lookup(inKey);
        const out = this._catalog.lookup(outKey);
        if (inp?.stream)
            this._mixer.set_default_source(inp.stream);
        if (out?.stream)
            this._mixer.set_default_sink(out.stream);
    }

    /**
     * Дождаться, пока все устройства будут присутствовать. Отсутствующие
     * проводные — сразу ошибка; Bluetooth — подключаем и ждём ноду.
     */
    async _ensurePresent(entries, op) {
        const _ = this._;
        const missing = entries.filter(e => !e.present);
        if (!missing.length)
            return;

        const wired = missing.find(e => !e.bluetooth);
        if (wired)
            throw new SwitchError(fmt(_('%s is not connected'), wired.displayName));
        if (!this._bluez)
            throw new SwitchError(_('Bluetooth is not available'));

        const keys = missing.map(e => e.key);
        const macs = [...new Set(missing.map(e => e.match.btAddress))];
        const names = [...new Set(missing.map(e => e.displayName))].join(', ');
        const timeoutSec = Math.round(this._timeoutMs / 1000);

        await new Promise((resolve, reject) => {
            let done = false;
            let changedId = 0, timeoutId = 0, cancelId = 0;
            const finish = (err = null, fromCancel = false) => {
                if (done)
                    return;
                done = true;
                if (changedId)
                    this._catalog.disconnect(changedId);
                if (timeoutId)
                    GLib.source_remove(timeoutId);
                // g_cancellable_disconnect() из обработчика отмены — deadlock;
                // после отмены cancellable одноразовый, обработчик можно оставить.
                if (cancelId && !fromCancel)
                    op.cancellable.disconnect(cancelId);
                if (err)
                    reject(err);
                else
                    resolve();
            };
            const check = () => {
                if (keys.every(k => this._catalog.lookup(k)?.present))
                    finish();
            };

            changedId = this._catalog.connect('changed', check);
            timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this._timeoutMs, () => {
                timeoutId = 0;
                finish(new SwitchError(fmt(_('%s did not connect in %d seconds'),
                    names, timeoutSec)));
                return GLib.SOURCE_REMOVE;
            });
            // Gio.Cancellable.connect (не GObject): сразу зовёт callback, если уже отменено.
            cancelId = op.cancellable.connect(() => finish(cancelledError(), true));
            if (done)
                return;

            for (const mac of macs) {
                this._bluez.connectDevice(mac, op.cancellable).catch(e => {
                    if (isCancelled(e) || BENIGN_CONNECT_ERRORS.test(e.message))
                        return;
                    finish(new SwitchError(fmt(_('%s: %s'), names, e.message)));
                });
            }
            check();
        });
    }
}
