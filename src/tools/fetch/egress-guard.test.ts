import { describe, expect, test } from 'bun:test';
import { assertPublicUrl, isPrivateAddress } from './egress-guard.js';

describe('egress guard', () => {
  test('classifies private and public addresses', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.1.117', '172.20.0.1', '169.254.1.1', '100.64.0.1', '::1', 'fd00::1', '::ffff:192.168.1.1']) {
      expect(isPrivateAddress(ip)).toBe(true);
    }
    for (const ip of ['8.8.8.8', '87.242.101.125', '2a00:1450::1']) {
      expect(isPrivateAddress(ip)).toBe(false);
    }
  });

  test('rejects LAN hosts and literal private IPs', async () => {
    await expect(assertPublicUrl('http://192.168.1.101/api/toggle')).rejects.toThrow();
    await expect(assertPublicUrl('https://jbod.local/api/status')).rejects.toThrow();
    await expect(assertPublicUrl('http://localhost:10000/api/ups')).rejects.toThrow();
    await expect(assertPublicUrl('http://[::1]/')).rejects.toThrow();
    await expect(assertPublicUrl('file:///etc/passwd')).rejects.toThrow();
  });
});
