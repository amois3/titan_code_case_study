import { isIP } from 'net';
import { lookup as dnsLookup } from 'dns/promises';

/**
 * Outbound URL policy for the fetch tool.
 *
 * Confirmation still gates the call. This layer blocks the class of mistakes
 * where an approved (or future auto-allowed) request reaches loopback, link-
 * local, or RFC1918 addresses — including cloud metadata at 169.254.169.254.
 *
 * Override with TITAN_CODE_ALLOW_PRIVATE_NETWORK=1 when the operator deliberately
 * needs to hit local services.
 */

export interface UrlPolicyResult {
  allowed: boolean;
  reason?: string;
  hostname?: string;
}

export type DnsLookup = (
  hostname: string
) => Promise<Array<{ address: string; family: number }>>;

/** Injectable for tests — production uses dns.promises.lookup with a timeout. */
let dnsLookupImpl: DnsLookup = async (hostname) => {
  return dnsLookup(hostname, { all: true });
};

export function setDnsLookupForTests(impl: DnsLookup | null): void {
  dnsLookupImpl = impl ?? (async (hostname) => dnsLookup(hostname, { all: true }));
}

const DNS_TIMEOUT_MS = 1500;

async function lookupWithTimeout(hostname: string): Promise<Array<{ address: string; family: number }>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      dnsLookupImpl(hostname),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('dns lookup timeout')), DNS_TIMEOUT_MS);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function envAllowsPrivateNetwork(): boolean {
  return /^(1|true|yes|on)$/i.test(String(process.env.TITAN_CODE_ALLOW_PRIVATE_NETWORK || ''));
}

function isPrivateV4(parts: number[]): boolean {
  const [a, b] = parts;
  if (a === undefined || b === undefined) return false;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

function isPrivateV6(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (normalized === '::1') return true;
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true; // ULA
  if (normalized.startsWith('fe80:')) return true; // link-local
  // IPv4-mapped :ffff:127.0.0.1 etc.
  const mapped = normalized.match(/:ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped?.[1]) {
    const parts = mapped[1].split('.').map((n) => Number(n));
    if (parts.length === 4 && parts.every((n) => Number.isFinite(n))) {
      return isPrivateV4(parts);
    }
  }
  return false;
}

export function isPrivateOrLocalHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;

  const version = isIP(host);
  if (version === 4) {
    const parts = host.split('.').map((n) => Number(n));
    return isPrivateV4(parts);
  }
  if (version === 6) {
    return isPrivateV6(host);
  }
  return false;
}

export function checkUrlPolicySync(urlString: string): UrlPolicyResult {
  if (envAllowsPrivateNetwork()) {
    return { allowed: true };
  }

  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    return { allowed: false, reason: 'Blocked: invalid URL' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      allowed: false,
      reason: `Blocked: only http and https are allowed (got ${parsed.protocol})`,
      hostname: parsed.hostname
    };
  }

  const hostname = parsed.hostname;
  if (isPrivateOrLocalHostname(hostname)) {
    return {
      allowed: false,
      reason: [
        `Blocked: private or local network address (${hostname}).`,
        'Fetch refuses loopback, link-local, and RFC1918 targets by default.',
        'Set TITAN_CODE_ALLOW_PRIVATE_NETWORK=1 to allow deliberately.'
      ].join(' '),
      hostname
    };
  }

  return { allowed: true, hostname };
}

/**
 * Resolves the hostname and re-checks the address. Literal private IPs are
 * already caught by the sync check; this closes the common case of a name
 * that resolves to 127.0.0.1 or a LAN address.
 */
export async function checkUrlPolicy(urlString: string): Promise<UrlPolicyResult> {
  const sync = checkUrlPolicySync(urlString);
  if (!sync.allowed || envAllowsPrivateNetwork()) return sync;

  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    return { allowed: false, reason: 'Blocked: invalid URL' };
  }

  if (isIP(parsed.hostname)) {
    return sync;
  }

  try {
    const results = await lookupWithTimeout(parsed.hostname);
    for (const entry of results) {
      if (isPrivateOrLocalHostname(entry.address)) {
        return {
          allowed: false,
          reason: [
            `Blocked: ${parsed.hostname} resolves to private address ${entry.address}.`,
            'Set TITAN_CODE_ALLOW_PRIVATE_NETWORK=1 to allow deliberately.'
          ].join(' '),
          hostname: parsed.hostname
        };
      }
    }
  } catch {
    // DNS failure / timeout is not a policy decision — let fetch report the error.
  }

  return sync;
}
