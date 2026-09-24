// Pure device identification helpers: no GI, shared by the Shell, prefs and tests.
//
// A device key is a direction plus a stable identifier:
//   output:<node.name>        wired device
//   output:bt:<MAC>           Bluetooth, upper-case MAC with colons
// PipeWire/Gvc numeric node ids are not part of the key: they change on reconnect.

export const OUTPUT = 'output';
export const INPUT = 'input';

const MAC_RE = /^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/;
// Public BT node: bluez_output.AA:BB:CC:DD:EE:FF, sometimes with a .N suffix.
// Internal bluez_output_internal.AA_BB_... nodes do not match by name shape.
const BT_NODE_RE = /^bluez_(output|input)\.([0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){5})(?:\.\d+)?$/;

export function normalizeMac(mac) {
    const up = String(mac ?? '').trim().toUpperCase().replaceAll('_', ':');
    return MAC_RE.test(up) ? up : null;
}

export function makeKey(direction, match) {
    if (match?.btAddress)
        return `${direction}:bt:${normalizeMac(match.btAddress)}`;
    return `${direction}:${match.nodeName}`;
}

/**
 * @param {string} key
 * @returns {{direction: string, match: {nodeName?: string, btAddress?: string}}|null}
 */
export function parseKey(key) {
    const m = /^(output|input):(.+)$/.exec(String(key ?? ''));
    if (!m)
        return null;
    const [, direction, rest] = m;
    if (rest.startsWith('bt:')) {
        const btAddress = normalizeMac(rest.slice(3));
        return btAddress ? {direction, match: {btAddress}} : null;
    }
    return {direction, match: {nodeName: rest}};
}

/** Internal BlueZ nodes and monitor sources are never shown. */
export function isIgnoredNode(name) {
    return !name || name.includes('_internal.') || name.endsWith('.monitor');
}

/**
 * MAC of the public BT node of the given direction, or null.
 *
 * @param {string} name
 * @param {string} [direction]
 */
export function btAddressFromNodeName(name, direction) {
    const m = BT_NODE_RE.exec(name ?? '');
    if (!m)
        return null;
    if (direction && m[1] !== direction)
        return null;
    return normalizeMac(m[2]);
}

/** How a device is matched, given the name of the node found. */
export function matchForNodeName(name) {
    const btAddress = btAddressFromNodeName(name);
    return btAddress ? {btAddress} : {nodeName: name};
}

/**
 * Whether a node name matches a saved node.name, allowing for the suffix
 * WirePlumber adds on reconnect races. Both forms occur:
 *   alsa_output.usb-X-00.analog-stereo  ~  alsa_output.usb-X-00.7.analog-stereo
 *   alsa_input.usb-X-00.mono-fallback   ~  alsa_input.usb-X-00.mono-fallback.2
 * Nothing is cut from the saved name: `pci-0000_00_1f.3` itself contains `.3`.
 */
export function isSuffixedVariant(savedName, candidate) {
    if (candidate.startsWith(`${savedName}.`) &&
        /^\d+$/.test(candidate.slice(savedName.length + 1)))
        return true;

    const dot = savedName.lastIndexOf('.');
    if (dot <= 0)
        return false;
    const prefix = savedName.slice(0, dot);
    const last = savedName.slice(dot + 1);
    if (!candidate.startsWith(`${prefix}.`) || !candidate.endsWith(`.${last}`))
        return false;
    const middle = candidate.slice(prefix.length + 1, candidate.length - last.length - 1);
    return /^\d+$/.test(middle);
}

/**
 * Pick the node for a device from the names of one direction.
 * An exact match wins over a suffixed one.
 *
 * @param {{nodeName?: string, btAddress?: string}} match
 * @param {string} direction
 * @param {string[]} names
 * @returns {string|null}
 */
export function findNodeName(match, direction, names) {
    const candidates = names.filter(n => !isIgnoredNode(n));
    if (match.btAddress) {
        const mac = normalizeMac(match.btAddress);
        return candidates.find(n => btAddressFromNodeName(n, direction) === mac) ?? null;
    }
    if (candidates.includes(match.nodeName))
        return match.nodeName;
    return candidates.find(n => isSuffixedVariant(match.nodeName, n)) ?? null;
}
