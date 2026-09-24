// Curated set of device icons, shared by the Shell and prefs.
// Bundled SVGs live in extension/icons and are loaded as files: a *-symbolic.svg
// name is enough for St and GTK to recolor them with the theme.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {OUTPUT} from './matching.js';

// Marks a string for xgettext; the caller translates it with _().
const N_ = s => s;

const ICONS_DIR = GLib.build_filenamev([
    GLib.path_get_dirname(GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0])),
    'icons',
]);

const OWN = new Set([
    'audio-speaker-cabinet-symbolic',
    'audio-input-microphone-studio-symbolic',
    'earbuds-symbolic',
]);

export const ICONS = [
    {id: 'audio-headphones-symbolic', label: N_('Headphones')},
    {id: 'audio-headset-symbolic', label: N_('Headset')},
    {id: 'earbuds-symbolic', label: N_('Earbuds')},
    {id: 'audio-speaker-cabinet-symbolic', label: N_('Speaker')},
    {id: 'audio-speakers-symbolic', label: N_('Loudspeaker')},
    {id: 'video-display-symbolic', label: N_('Display')},
    {id: 'tv-symbolic', label: N_('TV')},
    {id: 'computer-symbolic', label: N_('Computer')},
    {id: 'audio-card-symbolic', label: N_('Sound card')},
    {id: 'audio-input-microphone-symbolic', label: N_('Microphone')},
    {id: 'audio-input-microphone-studio-symbolic', label: N_('Studio microphone')},
    {id: 'camera-web-symbolic', label: N_('Webcam')},
    {id: 'phone-symbolic', label: N_('Phone')},
];

export function giconFor(id) {
    if (OWN.has(id))
        return new Gio.FileIcon({file: Gio.File.new_for_path(`${ICONS_DIR}/${id}.svg`)});
    return new Gio.ThemedIcon({name: id});
}

/** Default icon until the user picks one. */
export function defaultIconFor({direction, bluetooth, match, stream}) {
    const name = (match?.nodeName ?? '').toLowerCase();
    const ff = stream?.form_factor ?? '';
    if (direction === OUTPUT) {
        if (bluetooth || ff === 'headset' || ff === 'headphone')
            return 'audio-headphones-symbolic';
        if (name.includes('hdmi') || name.includes('displayport'))
            return 'video-display-symbolic';
        return 'audio-speakers-symbolic';
    }
    if (bluetooth || ff === 'headset')
        return 'audio-headset-symbolic';
    if (ff === 'webcam' || name.includes('webcam') || name.includes('camera'))
        return 'camera-web-symbolic';
    return 'audio-input-microphone-symbolic';
}
