/**
 * Blocks fetches to loopback, private, link-local and other non-public
 * addresses. The web edition runs on a host inside a home LAN, so the agent
 * must not be able to reach internal services through web_fetch.
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const BLOCKED_SUFFIXES = ['.local', '.localhost', '.internal', '.lan', '.home', '.arpa'];

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

const V4_BLOCKS: Array<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const value = ipv4ToInt(ip);
    return V4_BLOCKS.some(([base, bits]) => {
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
      return (value & mask) === (ipv4ToInt(base) & mask);
    });
  }
  if (isIP(ip) === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::' || lower === '::1') return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return isPrivateAddress(mapped[1]);
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(lower);
  }
  return true;
}

export class EgressDeniedError extends Error {
  constructor(host: string) {
    super(`Адрес ${host} находится во внутренней сети — запрос заблокирован`);
  }
}

export async function assertPublicUrl(rawUrl: string): Promise<void> {
  const { hostname, protocol } = new URL(rawUrl);
  if (protocol !== 'https:' && protocol !== 'http:') throw new EgressDeniedError(hostname);
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) {
    throw new EgressDeniedError(host);
  }
  if (isIP(host)) {
    if (isPrivateAddress(host)) throw new EgressDeniedError(host);
    return;
  }
  const addresses = await lookup(host, { all: true });
  if (addresses.length === 0 || addresses.some((a) => isPrivateAddress(a.address))) {
    throw new EgressDeniedError(host);
  }
}
