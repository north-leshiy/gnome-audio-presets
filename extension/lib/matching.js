// Чистые функции идентификации устройств: без GI, общие для Shell, prefs и тестов.
//
// Ключ устройства — направление плюс стабильный признак:
//   output:<node.name>        проводное устройство
//   output:bt:<MAC>           Bluetooth, MAC в верхнем регистре через двоеточие
// Числовые id нод PipeWire/Gvc в ключ не входят: они меняются при переподключении.

export const OUTPUT = 'output';
export const INPUT = 'input';

const MAC_RE = /^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/;
// Публичная нода BT: bluez_output.AA:BB:CC:DD:EE:FF, иногда с суффиксом .N.
// Внутренние bluez_output_internal.AA_BB_… сюда не попадают по форме имени.
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

export function isInternalNode(name) {
    return /_internal\./.test(name);
}

export function isMonitorNode(name) {
    return name.endsWith('.monitor');
}

/** Ноды, которые не показываем вовсе. */
export function isIgnoredNode(name) {
    return !name || isInternalNode(name) || isMonitorNode(name);
}

/**
 * MAC публичной BT-ноды нужного направления или null.
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

/** Как устройство матчится по имени найденной ноды. */
export function matchForNodeName(name) {
    const btAddress = btAddressFromNodeName(name);
    return btAddress ? {btAddress} : {nodeName: name};
}

/**
 * Совпадает ли имя ноды с сохранённым node.name с поправкой на суффикс,
 * который WirePlumber добавляет при гонках переподключения. Встречаются обе формы:
 *   alsa_output.usb-X-00.analog-stereo  ~  alsa_output.usb-X-00.7.analog-stereo
 *   alsa_input.usb-X-00.mono-fallback   ~  alsa_input.usb-X-00.mono-fallback.2
 * Из сохранённого имени ничего не вырезаем: `pci-0000_00_1f.3` сам содержит `.3`.
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
 * Выбрать ноду для устройства из списка имён одного направления.
 * Точное совпадение важнее суффиксного.
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
