import { describe, expect, it } from 'vitest';
import type { BrowserManager } from './pageTypes';
import type { FrameContext, SnapshotElement } from './pageTypes';
import {
  enrichAmbiguousElementsWithAccessibility,
  isAmbiguousSemanticName,
  isAmbiguousSemanticRole,
  needsAccessibilityEnrichment
} from './accessibilityEnrichment';

/**
 * A control the DOM cannot name is a control the model cannot choose.
 *
 * Application forms are largely unlabelled divs with an icon in them, and a
 * snapshot of one reads as a list of `generic ""` — indistinguishable rows,
 * with the real question sitting in the accessible name Chrome computed and
 * nobody asked for. This asks, for those controls only, and never for a page
 * whose markup already says what it is.
 */

function element(overrides: Partial<SnapshotElement> & { ref: string }): SnapshotElement {
  return { role: 'generic', name: '', tag: 'div', ...overrides };
}

function context(overrides: Partial<FrameContext> = {}): FrameContext {
  return { frameId: 'FRAME', key: 'f0', url: 'https://example.test/apply', contextId: 7, ...overrides };
}

/** Answers Runtime.evaluate and Accessibility.getPartialAXTree the way Chrome does. */
function chrome(answers: Record<string, { name?: string; role?: string; ignored?: boolean } | null>): {
  manager: BrowserManager;
  calls: string[];
} {
  const calls: string[] = [];
  const objects = new Map<string, string>();
  let next = 0;
  const manager = {
    run: async (_target: string, method: string, params: Record<string, unknown>): Promise<unknown> => {
      calls.push(method);
      if (method === 'Runtime.evaluate') {
        const ref = /"(f\d+s\d+[ef]\d+)"/.exec(String(params.expression))?.[1] ?? '';
        if (answers[ref] === undefined || answers[ref] === null) return { result: { subtype: 'null' } };
        const objectId = `obj-${next++}`;
        objects.set(objectId, ref);
        return { result: { objectId } };
      }
      if (method === 'Accessibility.getPartialAXTree') {
        const ref = objects.get(String(params.objectId)) ?? '';
        const answer = answers[ref]!;
        return {
          nodes: [{
            ignored: answer.ignored ?? false,
            ...(answer.name ? { name: { value: answer.name } } : {}),
            ...(answer.role ? { role: { value: answer.role } } : {})
          }]
        };
      }
      return {};
    }
  } as unknown as BrowserManager;
  return { manager, calls };
}

describe('which controls are worth asking Chrome about', () => {
  it('asks about the ones the DOM failed to name', () => {
    expect(needsAccessibilityEnrichment(element({ ref: 'f0s1e1', role: 'generic', name: '' }))).toBe(true);
    expect(needsAccessibilityEnrichment(element({ ref: 'f0s1e2', role: 'button', name: '×' }))).toBe(true);
    expect(needsAccessibilityEnrichment(element({ ref: 'f0s1e3', role: 'div', tag: 'div', name: 'Submit' }))).toBe(true);
  });

  it('leaves an honestly marked control alone, so an honest page pays nothing', () => {
    expect(needsAccessibilityEnrichment(element({
      ref: 'f0s1e4', role: 'button', name: 'Submit application', tag: 'button'
    }))).toBe(false);
    expect(needsAccessibilityEnrichment(element({
      ref: 'f0s1e5', role: 'textbox', name: 'Email address', tag: 'input'
    }))).toBe(false);
  });

  it('never asks about a password field', () => {
    // The accessible name of a password input is not something to fetch,
    // widen the reach of, or put in a snapshot the model reads.
    expect(needsAccessibilityEnrichment(element({
      ref: 'f0s1e6', role: 'generic', name: '', tag: 'input', type: 'password'
    }))).toBe(false);
  });

  it('never asks about a handle it did not issue', () => {
    expect(needsAccessibilityEnrichment(element({ ref: 'not-a-ref' }))).toBe(false);
    expect(needsAccessibilityEnrichment(element({ ref: '../../etc/passwd' }))).toBe(false);
  });

  it('knows a name that only repeats the control type says nothing', () => {
    expect(isAmbiguousSemanticName('button', 'button', 'button')).toBe(true);
    expect(isAmbiguousSemanticName('…', 'button', 'button')).toBe(true);
    expect(isAmbiguousSemanticName('Continue', 'button', 'button')).toBe(false);
    expect(isAmbiguousSemanticRole('generic', 'div')).toBe(true);
    expect(isAmbiguousSemanticRole('div', 'div')).toBe(true);
    expect(isAmbiguousSemanticRole('button', 'div')).toBe(false);
  });
});

describe('what the accessibility answer is allowed to change', () => {
  const contexts = [context()];

  it('gives an unnamed control the name Chrome computed for it', async () => {
    const { manager } = chrome({ 'f0s1e1': { name: 'Upload your CV', role: 'button' } });

    const result = await enrichAmbiguousElementsWithAccessibility(
      manager, 'tab-1', contexts, [element({ ref: 'f0s1e1' })]
    );

    expect(result.elements[0]).toMatchObject({ name: 'Upload your CV', role: 'button' });
    expect(result).toMatchObject({ attempted: 1, enriched: 1, truncated: false });
  });

  it('leaves the element byte-for-byte alone when Chrome knows no better', async () => {
    const original = element({ ref: 'f0s1e1' });
    const { manager } = chrome({ 'f0s1e1': { name: 'div', role: 'generic' } });

    const result = await enrichAmbiguousElementsWithAccessibility(manager, 'tab-1', contexts, [original]);

    expect(result.elements[0]).toEqual(original);
    expect(result.enriched).toBe(0);
  });

  it('does not overwrite a name the DOM already had', async () => {
    const named = element({ ref: 'f0s1e1', role: 'generic', name: 'Years of experience', tag: 'div' });
    const { manager } = chrome({ 'f0s1e1': { name: 'Something else', role: 'textbox' } });

    const result = await enrichAmbiguousElementsWithAccessibility(manager, 'tab-1', contexts, [named]);

    // The role was ambiguous and is taken; the name was not, and is kept.
    expect(result.elements[0]).toMatchObject({ name: 'Years of experience', role: 'textbox' });
  });

  it('never mutates the array it was given', async () => {
    const input = [element({ ref: 'f0s1e1' })];
    const snapshotBefore = JSON.parse(JSON.stringify(input)) as SnapshotElement[];
    const { manager } = chrome({ 'f0s1e1': { name: 'Continue', role: 'button' } });

    await enrichAmbiguousElementsWithAccessibility(manager, 'tab-1', contexts, input);

    expect(input).toEqual(snapshotBefore);
  });

  it('ignores a node Chrome itself marks as ignored', async () => {
    const original = element({ ref: 'f0s1e1' });
    const { manager } = chrome({ 'f0s1e1': { name: 'Hidden decoration', ignored: true } });

    const result = await enrichAmbiguousElementsWithAccessibility(manager, 'tab-1', contexts, [original]);

    expect(result.elements[0]).toEqual(original);
  });
});

describe('what it costs a page that does not need it', () => {
  it('sends nothing to the browser when every control is already named', async () => {
    const { manager, calls } = chrome({});

    const result = await enrichAmbiguousElementsWithAccessibility(manager, 'tab-1', [context()], [
      element({ ref: 'f0s1e1', role: 'button', name: 'Submit', tag: 'button' }),
      element({ ref: 'f0s1e2', role: 'textbox', name: 'Email', tag: 'input' })
    ]);

    expect(calls).toEqual([]);
    expect(result).toMatchObject({ attempted: 0, enriched: 0 });
  });

  it('asks about no more than a handful, however many the page has', async () => {
    const many = Array.from({ length: 40 }, (_, index) => element({ ref: `f0s1e${index + 1}` }));
    const { manager, calls } = chrome(
      Object.fromEntries(many.map((item) => [item.ref, { name: `Field ${item.ref}`, role: 'textbox' }]))
    );

    const result = await enrichAmbiguousElementsWithAccessibility(manager, 'tab-1', [context()], many);

    // Two round trips each, and a hard ceiling on how many are asked about:
    // a snapshot is not allowed to turn into a crawl of the whole document.
    expect(result.attempted).toBeLessThanOrEqual(16);
    expect(result.truncated).toBe(true);
    expect(calls.filter((call) => call === 'Accessibility.getPartialAXTree').length).toBe(result.attempted);
    expect(result.elements).toHaveLength(40);
  });

  it('skips a control whose frame is not in this snapshot', async () => {
    const { manager, calls } = chrome({ 'f9s1e1': { name: 'From another document', role: 'button' } });

    const result = await enrichAmbiguousElementsWithAccessibility(
      manager, 'tab-1', [context()], [element({ ref: 'f9s1e1' })]
    );

    // A handle looked up in a document that was numbered differently could
    // rename the wrong control, which is worse than not naming it at all.
    expect(calls).toEqual([]);
    expect(result.attempted).toBe(0);
  });
});

describe('when the browser will not answer', () => {
  it('returns the snapshot unharmed if a lookup throws', async () => {
    const original = element({ ref: 'f0s1e1' });
    const manager = {
      run: async (): Promise<unknown> => { throw new Error('execution context was destroyed'); }
    } as unknown as BrowserManager;

    const result = await enrichAmbiguousElementsWithAccessibility(manager, 'tab-1', [context()], [original]);

    expect(result.elements[0]).toEqual(original);
    expect(result.enriched).toBe(0);
  });

  it('returns the snapshot unharmed when the node has gone', async () => {
    const original = element({ ref: 'f0s1e1' });
    const { manager } = chrome({ 'f0s1e1': null });

    const result = await enrichAmbiguousElementsWithAccessibility(manager, 'tab-1', [context()], [original]);

    expect(result.elements[0]).toEqual(original);
  });
});
