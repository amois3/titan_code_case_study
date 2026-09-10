import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_DOM_QUIET_MS,
  DEFAULT_DOM_SETTLE_TIMEOUT_MS,
  domSettleScript,
  waitForDomSettled
} from './pageSettled';

describe('waiting for DOM stability', () => {
  it('builds a bounded, parseable page script', () => {
    const script = domSettleScript(-20, 99_000);
    expect(() => new Function(`return ${script}`)).not.toThrow();
    expect(script).toContain('/* titan:dom-settle */');
    expect(script).toContain('const quietMs = 0');
    expect(script).toContain('const timeoutMs = 10000');
    expect(script).toContain('new MutationObserver');
  });

  it('returns the quiet result from the page', async () => {
    const evaluate = vi.fn(async (_tabId: string, _expression: string) => ({ reason: 'quiet', elapsedMs: 146.4, mutations: 7 }));
    const result = await waitForDomSettled({ evaluate }, 'tab-1');

    expect(result).toEqual({ settled: true, reason: 'quiet', elapsedMs: 146, mutations: 7 });
    expect(evaluate).toHaveBeenCalledWith(
      'tab-1',
      expect.stringContaining(`const quietMs = ${DEFAULT_DOM_QUIET_MS}`)
    );
    expect(evaluate.mock.calls[0]?.[1]).toContain(`const timeoutMs = ${DEFAULT_DOM_SETTLE_TIMEOUT_MS}`);
  });

  it('keeps a busy page bounded by the timeout', async () => {
    const evaluate = vi.fn(async (_tabId: string, _expression: string) => ({ reason: 'timeout', elapsedMs: 800, mutations: 50_000 }));
    await expect(waitForDomSettled({ evaluate }, 'tab-1', { quietMs: 80, timeoutMs: 800 })).resolves.toEqual({
      settled: false,
      reason: 'timeout',
      elapsedMs: 800,
      mutations: 50_000
    });
  });

  it('treats a destroyed execution context as navigation', async () => {
    const evaluate = vi.fn(async (_tabId: string, _expression: string) => { throw new Error('Execution context was destroyed.'); });
    await expect(waitForDomSettled({ evaluate }, 'tab-1')).resolves.toEqual({
      settled: false,
      reason: 'navigation',
      elapsedMs: 0,
      mutations: 0
    });
  });

  it('fails open on an unexpected page answer', async () => {
    const evaluate = vi.fn(async (_tabId: string, _expression: string) => ({ reason: 'surprise', elapsedMs: 'forever', mutations: -9 }));
    await expect(waitForDomSettled({ evaluate }, 'tab-1')).resolves.toEqual({
      settled: false,
      reason: 'unavailable',
      elapsedMs: 0,
      mutations: 0
    });
  });
});
