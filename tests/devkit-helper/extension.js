// Только для вложенного devkit-Shell (tests/devkit.sh): разрешает Eval и
// Screenshot по D-Bus изолированной сессии. В настоящую сессию не ставить.
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

export default class DevkitHelper extends Extension {
    enable() {
        global.context.unsafe_mode = true;
    }

    disable() {
        global.context.unsafe_mode = false;
    }
}
