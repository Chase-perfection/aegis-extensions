/*
 * Curated MAC OUI → vendor lookup. Deliberately small: the common enterprise
 * and consumer gear an AD network actually contains. An unknown prefix returns
 * null (no guess). Grow OUI_MAP when a real gap shows up — do not import the
 * full 35k IEEE registry unless coverage demands it.
 *
 * Keys are the first 3 bytes (6 hex chars), uppercase, no separators.
 */
'use strict';

const OUI_MAP = {
    '005056': 'VMware', '000C29': 'VMware', '000569': 'VMware', '001C14': 'VMware',
    '00155D': 'Microsoft (Hyper-V)', '0003FF': 'Microsoft',
    '080027': 'VirtualBox', '525400': 'QEMU/KVM',
    '001DD8': 'Microsoft', '000D3A': 'Microsoft',
    'F01FAF': 'Dell', '00188B': 'Dell', 'B8CA3A': 'Dell', '18DBF2': 'Dell', 'D067E5': 'Dell',
    '3CD92B': 'HP', '009C02': 'HP', '00215A': 'HP', '984BE1': 'HP', '80CE62': 'HP',
    '000E7F': 'Hewlett-Packard', 'A0481C': 'HP',
    '0018FE': 'HP', '001B78': 'HP',
    '00000C': 'Cisco', '001A2F': 'Cisco', 'E05FB9': 'Cisco', '00D0BC': 'Cisco', 'F09E63': 'Cisco',
    '0050F0': 'Cisco', '00407F': 'Cisco',
    '18E829': 'Ubiquiti', '245A4C': 'Ubiquiti', 'FCECDA': 'Ubiquiti', '802AA8': 'Ubiquiti', '687251': 'Ubiquiti',
    '000B86': 'Aruba', '6CF37F': 'Aruba', '204C03': 'Aruba',
    '000C42': 'MikroTik', '4C5E0C': 'MikroTik', '6C3B6B': 'MikroTik',
    '00090F': 'Fortinet', '085B0E': 'Fortinet', '90170B': 'Fortinet',
    '001392': 'Hikvision', '4C11BF': 'Hikvision', 'C0568D': 'Hikvision', 'BCAD28': 'Hikvision',
    '000F7C': 'Axis', 'ACCC8E': 'Axis',
    'F0D5BF': 'Dahua', '3C1B6E': 'Dahua',
    'B827EB': 'Raspberry Pi', 'DCA632': 'Raspberry Pi', 'E45F01': 'Raspberry Pi', '2CCF67': 'Raspberry Pi',
    '001132': 'Synology', '0011D8': 'Synology', '90093C': 'Synology',
    '000420': 'QNAP', '245EBE': 'QNAP',
    '3C0754': 'Apple', 'A4C361': 'Apple', 'F0DBF8': 'Apple', '8866A5': 'Apple', 'ACBC32': 'Apple',
    '001CB3': 'Apple', '3451C9': 'Apple',
    'FCFBFB': 'Cisco', '00E04C': 'Realtek', '52540A': 'Realtek',
    'D4BED9': 'Dell', 'F8BC12': 'Dell', 'A44CC8': 'Dell',
    '001E58': 'D-Link', '1CBDB9': 'D-Link', '340804': 'D-Link',
    '000FB5': 'Netgear', '20E52A': 'Netgear', 'A040A0': 'Netgear',
    '0024A5': 'Buffalo', 'DC0EA1': 'Zebra', '00074D': 'Zebra',
    'E0DB55': 'Dell', '00219B': 'Dell'
};

/**
 * @param {string} mac e.g. "00:50:56:AB:CD:EF" / "00-50-56-..." / "005056..."
 * @returns {string|null} vendor name, or null when unknown/malformed
 */
function vendorForMac(mac) {
    if (!mac || typeof mac !== 'string') return null;
    const hex = mac.replace(/[^0-9a-fA-F]/g, '').toUpperCase();
    if (hex.length < 6) return null;
    return OUI_MAP[hex.slice(0, 6)] || null;
}

module.exports = { vendorForMac, OUI_MAP };
