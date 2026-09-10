import { describe, expect, it } from 'vitest';
import {
  KEEP_RECENT_TOOL_RESULTS,
  KEEP_RECENT_TOOL_PAYLOADS,
  PRUNE_AT_FRACTION,
  pruneThreshold,
  WORKING_CONTEXT_CEILING,
  advanceCollapseFrontier,
  applyCollapse,
  collapseHistoricalFileAttachments,
  collapseHistoricalToolPayloads,
  estimateContextTokens,
  pruneContextIfNeeded,
  type ContextEntry
} from './contextBudget';
import { messageContentToText } from './messageContent';

/**
 * A recorded audit run ended on the provider's 256k context limit. Compaction
 * was measured once, before the loop, against the session history — never
 * against the context the loop itself builds one tool result at a time.
 */
describe('context budget', () => {
  const bigToolResult = (label: string, kb = 40): ContextEntry => ({
    role: 'tool',
    content: JSON.stringify({ success: true, data: `${label}:${'x'.repeat(kb * 1024)}` }),
    tool_call_id: `call_${label}`,
    name: 'read_file'
  });

  it('leaves a context that fits alone', () => {
    const context: ContextEntry[] = [
      { role: 'system', content: 'prompt' },
      { role: 'user', content: 'audit this' },
      bigToolResult('a', 1)
    ];
    const outcome = pruneContextIfNeeded(context, 128_000);
    expect(outcome.pruned).toBe(false);
    expect(context[2]?.content).toContain('a:');
  });

  it('shortens only old large tool payloads before model compaction', () => {
    const context: ContextEntry[] = [{ role: 'system', content: 'prompt' }];
    for (let i = 0; i < 14; i++) context.push(bigToolResult(`f${i}`, 4));
    const idsBefore = context.filter((entry) => entry.role === 'tool').map((entry) => entry.tool_call_id);

    const frontier = advanceCollapseFrontier(context, 0, true);
    const collapsed = collapseHistoricalToolPayloads(context, frontier);

    expect(collapsed).toBe(14 - KEEP_RECENT_TOOL_PAYLOADS);
    expect(String(context[1]?.content)).toContain('historical tool result shortened');
    expect(String(context.at(-1)?.content)).toContain('f13:');
    expect(context.filter((entry) => entry.role === 'tool').map((entry) => entry.tool_call_id)).toEqual(idsBefore);
    expect(collapseHistoricalToolPayloads(context, frontier)).toBe(0);
  });

  it('ages old PDF text into a re-readable attachment reference', () => {
    const context: ContextEntry[] = [{
      role: 'user',
      content: [{
        type: 'file_attachment',
        file_attachment: {
          name: 'resume.pdf', path: 'C:\\resume.pdf', mime_type: 'application/pdf',
          text: 'exact resume text', pages_read: 1, total_pages: 1, truncated: false
        }
      }]
    }];
    for (let i = 0; i < 20; i++) context.push({ role: 'assistant', content: `step ${i}` });

    expect(collapseHistoricalFileAttachments(context)).toBe(1);
    expect(messageContentToText(context[0]!.content)).toContain('Call resume_read');
    expect(messageContentToText(context[0]!.content)).not.toContain('exact resume text');
  });

  it('replaces old tool payloads once the window fills', () => {
    const context: ContextEntry[] = [{ role: 'system', content: 'prompt' }];
    for (let i = 0; i < 30; i++) context.push(bigToolResult(`f${i}`));

    const before = estimateContextTokens(context);
    expect(before).toBeGreaterThan(128_000 * PRUNE_AT_FRACTION);

    const outcome = pruneContextIfNeeded(context, 128_000);
    expect(outcome.pruned).toBe(true);
    expect(outcome.after).toBeLessThan(outcome.before);
    expect(outcome.after).toBeLessThanOrEqual(Math.floor(128_000 * PRUNE_AT_FRACTION));
  });

  it('keeps the most recent results verbatim', () => {
    const context: ContextEntry[] = [{ role: 'system', content: 'prompt' }];
    for (let i = 0; i < 30; i++) context.push(bigToolResult(`f${i}`));

    pruneContextIfNeeded(context, 128_000);

    const tail = context.slice(-KEEP_RECENT_TOOL_RESULTS);
    for (const entry of tail) {
      expect(String(entry.content)).not.toContain('dropped to stay inside');
    }
    expect(String(context.at(-1)?.content)).toContain('f29:');
  });

  it('keeps every tool result answering its tool call', () => {
    // Dropping messages outright would leave an assistant tool_calls entry
    // with no matching result, which the API rejects. Only content is
    // replaced, so the shape of the exchange survives.
    const context: ContextEntry[] = [{ role: 'system', content: 'prompt' }];
    for (let i = 0; i < 30; i++) context.push(bigToolResult(`f${i}`));
    const idsBefore = context.filter((e) => e.role === 'tool').map((e) => e.tool_call_id);

    pruneContextIfNeeded(context, 128_000);

    const idsAfter = context.filter((e) => e.role === 'tool').map((e) => e.tool_call_id);
    expect(idsAfter).toEqual(idsBefore);
    expect(context.filter((e) => e.role === 'tool')).toHaveLength(30);
  });

  it('never touches the system prompt or the user request', () => {
    const context: ContextEntry[] = [
      { role: 'system', content: 'system prompt worth keeping' },
      { role: 'user', content: 'Проведи полный аудит данной системы.' }
    ];
    for (let i = 0; i < 30; i++) context.push(bigToolResult(`f${i}`));

    pruneContextIfNeeded(context, 128_000);

    expect(context[0]?.content).toBe('system prompt worth keeping');
    expect(context[1]?.content).toBe('Проведи полный аудит данной системы.');
  });

  it('is idempotent', () => {
    const context: ContextEntry[] = [{ role: 'system', content: 'prompt' }];
    for (let i = 0; i < 30; i++) context.push(bigToolResult(`f${i}`));

    pruneContextIfNeeded(context, 128_000);
    const afterFirst = estimateContextTokens(context);
    const second = pruneContextIfNeeded(context, 128_000);
    expect(estimateContextTokens(context)).toBe(afterFirst);
    expect(second.prunedCount).toBe(0);
  });

  it('gives up the recent window before giving up the run', () => {
    // Sixty results of 40 KB each cannot fit under the limit even with every
    // old one stubbed, so the keep-recent window has to shrink rather than
    // send a request the provider will refuse. A stub keeps the tool_call_id
    // pairing intact; a refused request ends the run.
    const context: ContextEntry[] = [{ role: 'system', content: 'prompt' }];
    for (let i = 0; i < 60; i++) context.push(bigToolResult(`f${i}`, 64));

    const outcome = pruneContextIfNeeded(context, 128_000);

    expect(outcome.after).toBeLessThanOrEqual(Math.floor(128_000 * PRUNE_AT_FRACTION));
    // The single newest result still says what it said.
    expect(String(context.at(-1)?.content)).toContain('f59:');
    // More than the keep-recent window had to give way: the first pass
    // protects six, so fifty-five stubs means the second pass went past it.
    const stubs = context.filter((e) => String(e.content).includes('dropped to stay inside'));
    expect(stubs.length).toBeGreaterThan(60 - KEEP_RECENT_TOOL_RESULTS);
  });

  it('counts provider state, which the wire adapters replay verbatim', () => {
    // A signed thinking block or an encrypted reasoning item is billed input
    // on every later request. Not counting it was the same blind spot as
    // unpriced base64: the estimator says the context fits while the provider
    // is already over the limit.
    const context: ContextEntry[] = [
      { role: 'system', content: 'prompt' },
      { role: 'assistant', content: 'working on it' }
    ];
    const without = estimateContextTokens(context);
    context[1]!.provider_state = [{ type: 'thinking', thinking: 'y'.repeat(10_000), signature: 'sig' }];
    expect(estimateContextTokens(context) - without).toBeGreaterThan(2_000);
  });
});

/**
 * How much context is worth carrying, as opposed to how much fits.
 *
 * The two were the same number: pruning began at 0.7 of the model's window, so
 * raising a catalogued window from 128K to the million the provider actually
 * bills for moved the trim point from 89,600 tokens to 700,000 — and every turn
 * resends all of it. Measured on a real session: 258,000 tokens of context, 82%
 * of it old tool results the run had already acted on, none of it trimmed.
 */
describe('where trimming starts', () => {
  it('is the fraction of the window on a small one', () => {
    expect(pruneThreshold(128_000)).toBe(89_600);
    expect(pruneThreshold(32_000)).toBe(22_400);
  });

  /** The window is room to read a big page. It is not a budget to spend. */
  it('stops at the working ceiling on a large one', () => {
    expect(pruneThreshold(1_000_000)).toBe(WORKING_CONTEXT_CEILING);
    expect(pruneThreshold(256_000)).toBe(WORKING_CONTEXT_CEILING);
  });

  it('never exceeds what the window itself allows', () => {
    for (const window of [8_000, 32_000, 128_000, 200_000, 1_000_000]) {
      expect(pruneThreshold(window)).toBeLessThanOrEqual(Math.floor(window * PRUNE_AT_FRACTION));
    }
  });

  /**
   * The session that prompted this: it sat under the window-derived threshold
   * and over the ceiling, so nothing was trimmed and every turn paid for all of
   * it.
   */
  it('would have trimmed the session that went untrimmed', () => {
    const measured = 257_884;

    expect(measured).toBeLessThan(Math.floor(1_000_000 * PRUNE_AT_FRACTION));
    expect(measured).toBeGreaterThan(pruneThreshold(1_000_000));
  });
});

/**
 * The prefix is the product here, and it is worth money.
 *
 * Providers price a cached prompt at a fiftieth of a fresh one, keyed on the
 * request being byte-identical from the start. The window of results kept whole
 * used to slide by one every turn, so one more message was rewritten every turn
 * and the prefix never held still — measured on a real run as 97.7% of the
 * prompt cached while the context sat under the ceiling, and 74% from the turn
 * it was crossed: 33,398 fresh tokens a turn where 1,852 had been, with no more
 * information reaching the model.
 */
describe('the frontier that keeps a prefix still', () => {
  const toolResult = (label: string): ContextEntry => ({
    role: 'tool',
    content: JSON.stringify({ success: true, data: `${label}:${'x'.repeat(4 * 1024)}` }),
    tool_call_id: `call_${label}`,
    name: 'read_file'
  });

  function history(toolResults: number): ContextEntry[] {
    const entries: ContextEntry[] = [{ role: 'system', content: 'prompt' }];
    for (let index = 0; index < toolResults; index++) entries.push(toolResult(`f${index}`));
    return entries;
  }

  function rendered(entries: ContextEntry[]): string {
    return entries.map((entry) => String(entry.content)).join('\u0000');
  }

  it('shortens the same messages on the next turn, and no others', () => {
    const first = history(14);
    const frontier = advanceCollapseFrontier(first, 0, true);
    collapseHistoricalToolPayloads(first, frontier);

    // The next turn: one more result, no new pressure. The history is rebuilt
    // from the store, so the frontier has to be applied again to the same point.
    const second = history(15);
    const held = advanceCollapseFrontier(second, frontier, false);
    collapseHistoricalToolPayloads(second, held);

    expect(held).toBe(frontier);
    // Everything the first turn sent is still there, byte for byte; the second
    // turn only added to the end.
    expect(rendered(second).startsWith(rendered(first))).toBe(true);
  });

  it('never moves backwards, so nothing is ever un-shortened', () => {
    const entries = history(14);
    const far = advanceCollapseFrontier(entries, 0, true);

    // Fewer results in view, and no pressure: the frontier must not retreat,
    // because un-shortening rewrites the prefix in the other direction and is
    // paid for exactly the same.
    expect(advanceCollapseFrontier(history(9), far, false)).toBe(far);
    expect(advanceCollapseFrontier(history(9), far, true)).toBe(far);
  });

  it('keeps the status of a result that carried no payload of its own', () => {
    // A tool that reports and returns nothing — a click, a wait — puts its
    // whole answer in `message`. Shortening must keep that sentence rather
    // than reduce the entry to the word "true", because it is the only record
    // of what the tool did.
    const entries: ContextEntry[] = [{ role: 'system', content: 'prompt' }];
    for (let index = 0; index < 12; index++) {
      entries.push({
        role: 'tool',
        content: JSON.stringify({
          success: true,
          message: `Clicked "Send" and the dialog closed. ${'detail '.repeat(500)}`
        }),
        tool_call_id: `call_${index}`,
        name: 'page_click'
      });
    }

    collapseHistoricalToolPayloads(entries, advanceCollapseFrontier(entries, 0, true));

    const shortened = JSON.parse(String(entries[1]?.content)) as { success: boolean; message: string };
    expect(shortened.success).toBe(true);
    expect(shortened.message).toContain('Clicked');
    expect(shortened.message).toContain('the dialog closed');
    expect(shortened.message).toContain('historical tool result shortened');
  });

  it('leaves the history untouched when the frontier has not moved', () => {
    // The three callers in the agent loop run this every turn, frontier or no
    // frontier. A no-op has to be exactly that: rewriting anything here is
    // what the whole change exists to stop.
    const entries = history(20);
    const before = rendered(entries);

    applyCollapse(entries, 0);

    expect(rendered(entries)).toBe(before);
  });

  it('shortens up to the frontier when it has', () => {
    const entries = history(20);

    applyCollapse(entries, 5);

    expect(String(entries[1]?.content)).toContain('historical tool result shortened');
    expect(String(entries[6]?.content)).not.toContain('historical tool result shortened');
  });

  it('advances only when the context is actually under pressure', () => {
    const entries = history(20);

    expect(advanceCollapseFrontier(entries, 0, false)).toBe(0);
    expect(advanceCollapseFrontier(entries, 0, true)).toBe(20 - KEEP_RECENT_TOOL_PAYLOADS);
  });

  it('keeps more history whole between advances than a sliding window did', () => {
    // The sliding window shortened a payload the turn it aged out of the recent
    // set. The frontier keeps it whole until the next advance, which is both
    // cheaper and more informative — the opposite of a trade.
    const entries = history(20);
    const frontier = advanceCollapseFrontier(history(14), 0, true);
    const collapsed = collapseHistoricalToolPayloads(entries, frontier);

    expect(collapsed).toBe(14 - KEEP_RECENT_TOOL_PAYLOADS);
    expect(collapsed).toBeLessThan(20 - KEEP_RECENT_TOOL_PAYLOADS);
  });
});
