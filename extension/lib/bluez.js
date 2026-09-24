// BlueZ over the system D-Bus: paired audio devices and connecting to them.
// Without BlueZ or an adapter the list is simply empty; no errors are thrown.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {Emitter} from './emitter.js';
import {normalizeMac} from './matching.js';

const BUS_NAME = 'org.bluez';
const DEVICE_IFACE = 'org.bluez.Device1';
const OM_IFACE = 'org.freedesktop.DBus.ObjectManager';
const PROPS_IFACE = 'org.freedesktop.DBus.Properties';

const UUID_A2DP_SINK = '0000110b-0000-1000-8000-00805f9b34fb';
const UUID_HFP_HF = '0000111e-0000-1000-8000-00805f9b34fb';
const UUID_HSP_HS = '00001108-0000-1000-8000-00805f9b34fb';

function unpack(v) {
    return v instanceof GLib.Variant ? v.recursiveUnpack() : v;
}

/** Flatten Device1 properties into a device object. */
function deviceFromProps(path, props) {
    const address = normalizeMac(unpack(props.Address));
    if (!address)
        return null;
    const uuids = (unpack(props.UUIDs) ?? []).map(u => String(u).toLowerCase());
    const audioIcon = (unpack(props.Icon) ?? '').startsWith('audio-');
    return {
        path,
        address,
        name: unpack(props.Alias) || unpack(props.Name) || address,
        paired: Boolean(unpack(props.Paired)),
        connected: Boolean(unpack(props.Connected)),
        hasOutput: uuids.includes(UUID_A2DP_SINK) || audioIcon,
        hasInput: uuids.includes(UUID_HFP_HF) || uuids.includes(UUID_HSP_HS),
    };
}

export class BluezClient extends Emitter {
    constructor() {
        super();
        this._bus = Gio.DBus.system;
        this._devices = new Map(); // path -> device
        this._subs = [];
        this._cancellable = new Gio.Cancellable();
    }

    async start() {
        this._subscribe(OM_IFACE, 'InterfacesAdded', null, (path, params) => {
            const [objPath, ifaces] = params.deepUnpack();
            if (ifaces[DEVICE_IFACE])
                this._update(objPath, ifaces[DEVICE_IFACE], true);
        });
        this._subscribe(OM_IFACE, 'InterfacesRemoved', null, (path, params) => {
            const [objPath, ifaces] = params.deepUnpack();
            if (ifaces.includes(DEVICE_IFACE) && this._devices.delete(objPath))
                this.emit('changed');
        });
        this._subscribe(PROPS_IFACE, 'PropertiesChanged', DEVICE_IFACE, (path, params) => {
            const [, changed] = params.deepUnpack();
            if (this._devices.has(path))
                this._update(path, changed, false);
        });

        try {
            const reply = await this._call('/', OM_IFACE, 'GetManagedObjects', null,
                new GLib.VariantType('(a{oa{sa{sv}}})'));
            const [objects] = reply.deepUnpack();
            for (const [path, ifaces] of Object.entries(objects)) {
                if (ifaces[DEVICE_IFACE])
                    this._update(path, ifaces[DEVICE_IFACE], true, false);
            }
            this.emit('changed');
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                console.debug(`audio-presets: BlueZ unavailable: ${e.message}`);
        }
    }

    /** Paired audio devices. */
    get audioDevices() {
        return [...this._devices.values()].filter(d => d.paired && (d.hasOutput || d.hasInput));
    }

    lookup(address) {
        const mac = normalizeMac(address);
        return [...this._devices.values()].find(d => d.address === mac) ?? null;
    }

    /**
     * Connect a device. Resolves when BlueZ replies (not when the PipeWire node
     * appears; the caller waits for that). Throws an error with a readable message.
     */
    async connectDevice(address, cancellable = null) {
        const dev = this.lookup(address);
        if (!dev)
            throw new Error('device is not paired');
        if (dev.connected)
            return;
        await this._call(dev.path, DEVICE_IFACE, 'Connect', null, null, cancellable);
    }

    destroy() {
        this._cancellable.cancel();
        for (const id of this._subs)
            this._bus.signal_unsubscribe(id);
        this._subs = [];
        this._devices.clear();
        this.disconnectAll();
    }

    _update(path, props, replace, notify = true) {
        const base = replace ? {} : this._devices.get(path)?._raw;
        const merged = {...base, ...props};
        const dev = deviceFromProps(path, merged);
        if (!dev)
            return;
        dev._raw = merged;
        this._devices.set(path, dev);
        if (notify)
            this.emit('changed');
    }

    _subscribe(iface, member, arg0, callback) {
        this._subs.push(this._bus.signal_subscribe(
            BUS_NAME, iface, member, null, arg0, Gio.DBusSignalFlags.NONE,
            (conn, sender, path, ifaceName, signal, params) => callback(path, params)));
    }

    _call(path, iface, method, params, replyType, cancellable = this._cancellable) {
        return new Promise((resolve, reject) => {
            this._bus.call(BUS_NAME, path, iface, method, params, replyType,
                Gio.DBusCallFlags.NONE, -1, cancellable, (conn, res) => {
                    try {
                        resolve(conn.call_finish(res));
                    } catch (e) {
                        if (e instanceof GLib.Error && Gio.DBusError.is_remote_error(e))
                            Gio.DBusError.strip_remote_error(e);
                        reject(e);
                    }
                });
        });
    }
}
