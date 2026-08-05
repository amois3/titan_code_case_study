import { afterEach, describe, expect, it } from 'vitest';
import {
  checkUrlPolicy,
  checkUrlPolicySync,
  isPrivateOrLocalHostname,
  setDnsLookupForTests
} from './urlPolicy';

const previous = process.env.TITAN_CODE_ALLOW_PRIVATE_NETWORK;

afterEach(() => {
  if (previous === undefined) delete process.env.TITAN_CODE_ALLOW_PRIVATE_NETWORK;
  else process.env.TITAN_CODE_ALLOW_PRIVATE_NETWORK = previous;
  setDnsLookupForTests(null);
});

describe('urlPolicy', () => {
  it('classifies loopback and RFC1918 hosts as private', () => {
    expect(isPrivateOrLocalHostname('127.0.0.1')).toBe(true);
    expect(isPrivateOrLocalHostname('localhost')).toBe(true);
    expect(isPrivateOrLocalHostname('10.0.0.5')).toBe(true);
    expect(isPrivateOrLocalHostname('192.168.1.1')).toBe(true);
    expect(isPrivateOrLocalHostname('169.254.169.254')).toBe(true);
    expect(isPrivateOrLocalHostname('::1')).toBe(true);
    expect(isPrivateOrLocalHostname('example.com')).toBe(false);
  });

  it('blocks private literal URLs by default', () => {
    delete process.env.TITAN_CODE_ALLOW_PRIVATE_NETWORK;
    expect(checkUrlPolicySync('http://127.0.0.1:9/').allowed).toBe(false);
    expect(checkUrlPolicySync('http://169.254.169.254/latest').allowed).toBe(false);
    expect(checkUrlPolicySync('https://example.com/').allowed).toBe(true);
  });

  it('allows private URLs when the env override is set', () => {
    process.env.TITAN_CODE_ALLOW_PRIVATE_NETWORK = '1';
    expect(checkUrlPolicySync('http://127.0.0.1:9/').allowed).toBe(true);
  });

  it('rejects non-http schemes', () => {
    delete process.env.TITAN_CODE_ALLOW_PRIVATE_NETWORK;
    expect(checkUrlPolicySync('file:///etc/passwd').allowed).toBe(false);
  });

  it('blocks hostnames that resolve to private addresses (mocked DNS)', async () => {
    delete process.env.TITAN_CODE_ALLOW_PRIVATE_NETWORK;
    setDnsLookupForTests(async () => [{ address: '127.0.0.1', family: 4 }]);
    const result = await checkUrlPolicy('https://evil.example/');
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/private address 127\.0\.0\.1/i);
  });

  it('allows hostnames that resolve to public addresses (mocked DNS)', async () => {
    delete process.env.TITAN_CODE_ALLOW_PRIVATE_NETWORK;
    setDnsLookupForTests(async () => [{ address: '93.184.216.34', family: 4 }]);
    const result = await checkUrlPolicy('https://example.com/');
    expect(result.allowed).toBe(true);
  });

  it('does not fail closed when DNS errors', async () => {
    delete process.env.TITAN_CODE_ALLOW_PRIVATE_NETWORK;
    setDnsLookupForTests(async () => {
      throw new Error('dns lookup timeout');
    });
    const result = await checkUrlPolicy('https://slow.example/');
    // DNS failure falls through to sync allow for non-literal private hostnames.
    expect(result.allowed).toBe(true);
  });
});
