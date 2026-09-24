// Подделки Gvc.MixerControl и BluezClient для тестов ядра.
import Gvc from 'gi://Gvc';

import {Emitter} from '../../extension/lib/emitter.js';
import {normalizeMac} from '../../extension/lib/matching.js';

let nextId = 1;

export function fakeStream(name, description = name, extra = {}) {
    return {id: nextId++, name, description, form_factor: null, is_muted: false,
        volume: 30000, ...extra};
}

/** Имитирует сигналы и дефолты MixerControl. connect() возвращает id, как GObject. */
export class FakeMixer extends Emitter {
    constructor({sinks = [], sources = []} = {}) {
        super();
        this.sinks = sinks;
        this.sources = sources;
        this.defaultSink = sinks[0] ?? null;
        this.defaultSource = sources[0] ?? null;
        this.calls = [];
    }

    get_state() {
        return Gvc.MixerControlState.READY;
    }

    get_sinks() {
        return this.sinks;
    }

    get_sources() {
        return this.sources;
    }

    get_default_sink() {
        return this.defaultSink;
    }

    get_default_source() {
        return this.defaultSource;
    }

    set_default_sink(s) {
        this.calls.push(`sink:${s.name}`);
        this.defaultSink = s;
        this.emit('default-sink-changed', s.id);
    }

    set_default_source(s) {
        this.calls.push(`source:${s.name}`);
        this.defaultSource = s;
        this.emit('default-source-changed', s.id);
    }

    addSink(s) {
        this.sinks.push(s);
        this.emit('stream-added', s.id);
    }

    addSource(s) {
        this.sources.push(s);
        this.emit('stream-added', s.id);
    }

    removeSink(s) {
        this.sinks = this.sinks.filter(x => x !== s);
        this.emit('stream-removed', s.id);
    }
}

export class FakeBluez extends Emitter {
    constructor(devices = []) {
        super();
        this.devices = devices;
        this.connectCalls = [];
        this.onConnect = null; // (address, cancellable) => Promise
    }

    get audioDevices() {
        return this.devices.filter(d => d.paired);
    }

    lookup(address) {
        const mac = normalizeMac(address);
        return this.devices.find(d => d.address === mac) ?? null;
    }

    connectDevice(address, cancellable) {
        this.connectCalls.push(address);
        return this.onConnect ? this.onConnect(address, cancellable) : Promise.resolve();
    }
}
