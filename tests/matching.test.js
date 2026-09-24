import {test, eq, run} from './lib/assert.js';
import * as M from '../extension/lib/matching.js';

const BS = 'alsa_output.usb-Acme_USB_Headset-00.analog-stereo';
const PCI = 'alsa_output.pci-0000_00_1f.3.analog-stereo';
const MAC = 'AA:BB:CC:DD:EE:01';

test('keys: wired and BT', () => {
    eq(M.makeKey('output', {nodeName: BS}), `output:${BS}`);
    eq(M.makeKey('input', {btAddress: 'aa_bb_cc_dd_ee_01'}), `input:bt:${MAC}`);
    eq(M.parseKey(`output:${PCI}`), {direction: 'output', match: {nodeName: PCI}});
    eq(M.parseKey(`output:bt:${MAC}`), {direction: 'output', match: {btAddress: MAC}});
    eq(M.parseKey('garbage'), null);
    eq(M.parseKey('output:bt:not-a-mac'), null);
});

test('exact match', () => {
    eq(M.findNodeName({nodeName: BS}, 'output', [PCI, BS]), BS);
});

test('.7 suffix before the last segment', () => {
    const suffixed = 'alsa_output.usb-Acme_USB_Headset-00.7.analog-stereo';
    eq(M.findNodeName({nodeName: BS}, 'output', [PCI, suffixed]), suffixed);
});

test('suffix at the end of the name: mono-fallback.2', () => {
    const saved = 'alsa_input.usb-Acme_Studio_Mic_SN0001-00.mono-fallback';
    // this is how WirePlumber wrote it to ~/.local/state/wireplumber/default-nodes
    eq(M.findNodeName({nodeName: saved}, 'input', [`${saved}.2`]), `${saved}.2`);
    eq(M.isSuffixedVariant(saved, `${saved}.x`), false);
    eq(M.isSuffixedVariant(saved,
        'alsa_input.usb-Acme_Studio_Mic_SN0001-00.3.mono-fallback'), true);
});

test('PCI address with a dot: exact match beats the heuristic', () => {
    const other = 'alsa_output.pci-0000_00_1f.3.7.analog-stereo';
    eq(M.findNodeName({nodeName: PCI}, 'output', [other, PCI]), PCI);
    eq(M.findNodeName({nodeName: PCI}, 'output', [other]), other);
    // and the heuristic does not merge different PCI functions
    eq(M.isSuffixedVariant(PCI, 'alsa_output.pci-0000_00_1f.4.analog-stereo'), false);
});

test('no node: null', () => {
    eq(M.findNodeName({nodeName: BS}, 'output', [PCI]), null);
});

test('BT: public node by MAC, internal one dropped', () => {
    const names = [
        'bluez_output_internal.AA_BB_CC_DD_EE_01.1',
        `bluez_output.${MAC}`,
        PCI,
    ];
    eq(M.findNodeName({btAddress: MAC}, 'output', names), `bluez_output.${MAC}`);
    eq(M.findNodeName({btAddress: MAC}, 'output', [names[0]]), null);
});

test('BT: direction matters', () => {
    eq(M.findNodeName({btAddress: MAC}, 'input', [`bluez_output.${MAC}`]), null);
    eq(M.findNodeName({btAddress: MAC}, 'input', [`bluez_input.${MAC}`]), `bluez_input.${MAC}`);
    eq(M.btAddressFromNodeName(`bluez_input.${MAC}.1`, 'input'), MAC);
});

test('matchForNodeName', () => {
    eq(M.matchForNodeName(`bluez_output.${MAC}`), {btAddress: MAC});
    eq(M.matchForNodeName(BS), {nodeName: BS});
});

test('monitors and internal nodes are ignored', () => {
    eq(M.isIgnoredNode(`${BS}.monitor`), true);
    eq(M.isIgnoredNode('bluez_input_internal.AA_BB_CC_DD_EE_01.0'), true);
    eq(M.isIgnoredNode(BS), false);
});

await run();
