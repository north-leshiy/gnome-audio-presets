// Минимальные сигналы для обычных классов: модули lib/ работают и вне Shell
// (prefs, тесты), поэтому misc/signals.js из Shell здесь недоступен.
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
