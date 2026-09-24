// Gio.Settings расширения на memory-бэкенде: реальный dconf не трогается.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const SCHEMA_DIR = GLib.build_filenamev([
    GLib.path_get_dirname(GLib.path_get_dirname(
        GLib.filename_from_uri(import.meta.url)[0])),
    '..', 'extension', 'schemas',
]);

export function memorySettings() {
    const source = Gio.SettingsSchemaSource.new_from_directory(
        SCHEMA_DIR, Gio.SettingsSchemaSource.get_default(), false);
    const schema = source.lookup('org.gnome.shell.extensions.audio-presets', false);
    return new Gio.Settings({
        settings_schema: schema,
        backend: Gio.memory_settings_backend_new(),
    });
}
