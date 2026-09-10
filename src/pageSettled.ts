// pageSettled.ts - wait for the page to stop changing, without sleeping blind.

import type { BrowserManager } from './pageTypes';

export const DEFAULT_DOM_QUIET_MS = 140;
export const DEFAULT_DOM_SETTLE_TIMEOUT_MS = 1_400;

export type DomSettleReason = 'quiet' | 'timeout' | 'navigation' | 'unavailable';

export interface DomSettleResult {
  settled: boolean;
  reason: DomSettleReason;
  elapsedMs: number;
  mutations: number;
}

export interface DomSettleOptions {
  quietMs?: number;
  timeoutMs?: number;
}

interface RawSettleResult {
  reason?: unknown;
  elapsedMs?: unknown;
  mutations?: unknown;
}

function boundedInteger(value: unknown, fallback: number, maximum: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(maximum, Math.round(value)))
    : fallback;
}

/**
 * The observer lives only for this one wait. A long-lived observer would need
 * lifecycle and navigation bookkeeping of its own; this one is installed
 * after an action and removed as soon as the page has been quiet long enough.
 */
export function domSettleScript(quietMs: number, timeoutMs: number): string {
  const quiet = boundedInteger(quietMs, DEFAULT_DOM_QUIET_MS, 5_000);
  const timeout = Math.max(quiet, boundedInteger(timeoutMs, DEFAULT_DOM_SETTLE_TIMEOUT_MS, 10_000));
  return `(() => new Promise((resolve) => {
  /* titan:dom-settle */
  const quietMs = ${quiet};
  const timeoutMs = ${timeout};
  const started = performance.now();
  let lastChange = started;
  let mutations = 0;
  let timer = 0;
  let observer;

  const finish = (reason) => {
    if (timer) clearTimeout(timer);
    if (observer) observer.disconnect();
    resolve({
      reason,
      elapsedMs: Math.max(0, Math.round(performance.now() - started)),
      mutations
    });
  };

  const check = () => {
    const now = performance.now();
    if (now - lastChange >= quietMs) return finish('quiet');
    if (now - started >= timeoutMs) return finish('timeout');
    timer = setTimeout(check, Math.min(50, quietMs));
  };

  try {
    observer = new MutationObserver((records) => {
      mutations += records.length;
      lastChange = performance.now();
    });
    observer.observe(document.documentElement || document, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true
    });
    timer = setTimeout(check, Math.min(50, quietMs));
  } catch (_) {
    finish('unavailable');
  }
}))()`;
}

function normalise(value: unknown, timeoutMs: number): DomSettleResult {
  const raw = value && typeof value === 'object' ? value as RawSettleResult : {};
  const reason: DomSettleReason = raw.reason === 'quiet'
    ? 'quiet'
    : raw.reason === 'timeout'
      ? 'timeout'
      : 'unavailable';
  return {
    settled: reason === 'quiet',
    reason,
    elapsedMs: boundedInteger(raw.elapsedMs, 0, timeoutMs),
    mutations: boundedInteger(raw.mutations, 0, 1_000_000)
  };
}

/**
 * Wait for a short DOM quiet window, bounded by a hard timeout.
 *
 * Navigation destroys the execution context and therefore rejects the
 * evaluation. That is useful information rather than a failure: the caller
 * should read the new document as soon as it becomes available.
 */
export async function waitForDomSettled(
  manager: Pick<BrowserManager, 'evaluate'>,
  tabId: string,
  options: DomSettleOptions = {}
): Promise<DomSettleResult> {
  const quietMs = boundedInteger(options.quietMs, DEFAULT_DOM_QUIET_MS, 5_000);
  const timeoutMs = Math.max(
    quietMs,
    boundedInteger(options.timeoutMs, DEFAULT_DOM_SETTLE_TIMEOUT_MS, 10_000)
  );
  try {
    return normalise(await manager.evaluate(tabId, domSettleScript(quietMs, timeoutMs)), timeoutMs);
  } catch {
    return { settled: false, reason: 'navigation', elapsedMs: 0, mutations: 0 };
  }
}

