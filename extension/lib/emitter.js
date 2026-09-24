// Minimal signals for plain classes: lib/ modules also run outside the Shell
// (prefs, tests), where the Shell's misc/signals.js is not available.
export class Emitter {
    #handlers = new Map();
    #nextId = 1;

    connect(name, callback) {
        const id = this.#nextId++;
        this.#handlers.set(id, {name, callback});
        return id;
    }

    disconnect(id) {
        this.#handlers.delete(id);
    }

    emit(name, ...args) {
        for (const {name: n, callback} of [...this.#handlers.values()]) {
            if (n !== name)
                continue;
            try {
                callback(this, ...args);
            } catch (e) {
                console.error(`audio-presets: '${name}' handler failed: ${e}`);
            }
        }
    }

    disconnectAll() {
        this.#handlers.clear();
    }
}
