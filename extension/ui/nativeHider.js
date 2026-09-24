// Скрытие родных значков громкости на панели.
//
// quickSettings._volumeOutput/_volumeInput — приватные поля Shell; их видимость
// пересчитывает сам Shell (_syncIndicatorsVisible, bind_property), поэтому hide()
// не держится. Снимаем актёров из контейнера _indicators и возвращаем на те же
// места в restore(). Слайдеры внутри Quick Settings — другие актёры, их не трогаем.
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const WAIT_STEP_MS = 100;
const WAIT_LIMIT_MS = 10000;

export class NativeHider {
    constructor() {
        this._removed = [];
        this._waitId = 0;
    }

    hide() {
        let waited = 0;
        const attempt = () => {
            const qs = Main.panel.statusArea.quickSettings;
            if (qs?._volumeOutput && qs?._volumeInput && qs?._indicators) {
                this._waitId = 0;
                this._remove(qs._indicators, [qs._volumeInput, qs._volumeOutput]);
                return GLib.SOURCE_REMOVE;
            }
            waited += WAIT_STEP_MS;
            if (waited >= WAIT_LIMIT_MS) {
                this._waitId = 0;
                console.warn('audio-presets: built-in volume indicators not found, not hiding them');
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        };
        if (attempt() === GLib.SOURCE_CONTINUE)
            this._waitId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, WAIT_STEP_MS, attempt);
    }

    restore() {
        if (this._waitId)
            GLib.source_remove(this._waitId);
        this._waitId = 0;
        // Возвращаем в обратном порядке, чтобы индексы совпали с исходными.
        for (const {box, actor, index} of this._removed.reverse()) {
            if (actor.get_parent())
                continue;
            box.insert_child_at_index(actor, Math.min(index, box.get_n_children()));
        }
        this._removed = [];
    }

    _remove(box, actors) {
        for (const actor of actors) {
            if (actor.get_parent() !== box)
                continue;
            const index = box.get_children().indexOf(actor);
            box.remove_child(actor);
            this._removed.push({box, actor, index});
        }
    }
}
