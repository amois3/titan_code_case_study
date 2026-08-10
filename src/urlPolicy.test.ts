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

describe('the ways a private address can be written', () => {
  it('catches loopback however the URL parser leaves it', () => {
    // The parser normalises the integer, hex and octal forms of an IPv4
    // address, so these all arrive as 127.0.0.1 — but only if something looks.
    for (const url of ['http://2130706433/', 'http://0x7f000001/', 'http://0177.0.0.1/']) {
      expect(checkUrlPolicySync(url).allowed, url).toBe(false);
    }
  });

  it('catches an IPv4-mapped address written in hex', () => {
    // `::ffff:7f00:1` is 127.0.0.1. Only the dotted spelling was recognised,
    // so this went through to the loopback interface.
    expect(isPrivateOrLocalHostname('::ffff:7f00:1')).toBe(true);
    expect(isPrivateOrLocalHostname('::ffff:c0a8:1')).toBe(true);
    expect(checkUrlPolicySync('http://[::ffff:7f00:1]/').allowed).toBe(false);
  });

  it('catches an IPv4-mapped address written with dots', () => {
    expect(isPrivateOrLocalHostname('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateOrLocalHostname('::ffff:10.0.0.1')).toBe(true);
  });

  it('does not treat a mapped public address as private', () => {
    expect(isPrivateOrLocalHostname('::ffff:5db8:d822')).toBe(false);
  });

  it('catches the unspecified address, which reaches the local host', () => {
    expect(isPrivateOrLocalHostname('::')).toBe(true);
    expect(checkUrlPolicySync('http://[::]/').allowed).toBe(false);
  });

  it('ignores a zone index, which names an interface rather than a host', () => {
    expect(isPrivateOrLocalHostname('fe80::1%eth0')).toBe(true);
  });

  it('catches the other private ranges', () => {
    expect(isPrivateOrLocalHostname('172.16.0.1')).toBe(true);
    expect(isPrivateOrLocalHostname('172.31.255.255')).toBe(true);
    expect(isPrivateOrLocalHostname('172.32.0.1')).toBe(false);
    expect(isPrivateOrLocalHostname('100.64.0.1')).toBe(true);
    expect(isPrivateOrLocalHostname('0.0.0.0')).toBe(true);
    expect(isPrivateOrLocalHostname('fd00::1')).toBe(true);
    expect(isPrivateOrLocalHostname('fe80::1')).toBe(true);
  });

  it('catches the names that mean this machine', () => {
    expect(isPrivateOrLocalHostname('localhost')).toBe(true);
    expect(isPrivateOrLocalHostname('api.localhost')).toBe(true);
    expect(isPrivateOrLocalHostname('printer.local')).toBe(true);
    expect(isPrivateOrLocalHostname('')).toBe(true);
  });

  it('leaves an ordinary public address alone', () => {
    expect(isPrivateOrLocalHostname('93.184.216.34')).toBe(false);
    expect(isPrivateOrLocalHostname('2606:2800:220:1::1')).toBe(false);
  });
});

describe('what the refusal says', () => {
  it('names the address and the way to allow it deliberately', () => {
    delete process.env.TITAN_CODE_ALLOW_PRIVATE_NETWORK;
    const refusal = checkUrlPolicySync('http://169.254.169.254/latest/meta-data/');

    expect(refusal.reason).toContain('169.254.169.254');
    expect(refusal.reason).toContain('TITAN_CODE_ALLOW_PRIVATE_NETWORK');
    expect(refusal.hostname).toBe('169.254.169.254');
  });

  it('names the scheme it will not follow', () => {
    const refusal = checkUrlPolicySync('ftp://example.com/');
    expect(refusal.reason).toContain('ftp');
  });

  it('says a URL is not one rather than failing on it', () => {
    expect(checkUrlPolicySync('not a url').allowed).toBe(false);
    expect(checkUrlPolicySync('not a url').reason).toContain('invalid URL');
  });
});

describe('resolving before allowing', () => {
  it('does not look up an address that is already one', async () => {
    delete process.env.TITAN_CODE_ALLOW_PRIVATE_NETWORK;
    let looked = false;
    setDnsLookupForTests(async () => { looked = true; return []; });

    await checkUrlPolicy('https://93.184.216.34/');
    expect(looked).toBe(false);
  });

  it('blocks when any of several answers is private', async () => {
    delete process.env.TITAN_CODE_ALLOW_PRIVATE_NETWORK;
    setDnsLookupForTests(async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.7', family: 4 }
    ]);

    expect((await checkUrlPolicy('https://mixed.example/')).allowed).toBe(false);
  });

  it('skips the lookup entirely when the override is set', async () => {
    process.env.TITAN_CODE_ALLOW_PRIVATE_NETWORK = 'yes';
    let looked = false;
    setDnsLookupForTests(async () => { looked = true; return [{ address: '127.0.0.1', family: 4 }]; });

    expect((await checkUrlPolicy('http://internal.example/')).allowed).toBe(true);
    expect(looked).toBe(false);
  });

  it('gives up on a lookup that never answers', async () => {
    delete process.env.TITAN_CODE_ALLOW_PRIVATE_NETWORK;
    setDnsLookupForTests(() => new Promise(() => { /* never settles */ }));

    const started = Date.now();
    const result = await checkUrlPolicy('https://slow.example/');

    expect(result.allowed).toBe(true);
    expect(Date.now() - started).toBeLessThan(5000);
  }, 10_000);
});
