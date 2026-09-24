// Only for the nested devkit Shell (tests/devkit.sh): allows Eval and Screenshot
// over the isolated session's D-Bus. Never install into a real session.
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

export default class DevkitHelper extends Extension {
    enable() {
        global.context.unsafe_mode = true;
    }

    disable() {
        global.context.unsafe_mode = false;
    }
}
