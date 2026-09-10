// accessibilityEnrichment.ts - a small, selective bridge to Chrome's AX view.
//
// The DOM snapshot is the browser interface. Accessibility is only a second
// opinion for a control whose name or role is not useful enough to act on. A
// full AX tree would duplicate the page, add latency and hand the model a large
// second representation of the same document, so this module can only ask for
// one node at a time and always sets fetchRelatives to false.

import type { BrowserManager } from './pageTypes';
import type { FrameContext, SnapshotElement } from './pageTypes';

const REF_SHAPE = /^(f\d+)s\d+[ef]\d+$/;
const REF_ATTRIBUTE = 'data-titan-ref';
const DEFAULT_MAX_CANDIDATES = 8;
const HARD_MAX_CANDIDATES = 16;
const DEFAULT_CONCURRENCY = 4;
const MAX_AX_NAME = 200;
const MAX_AX_ROLE = 64;

const AMBIGUOUS_ROLES = new Set(['', 'generic', 'none', 'presentation', 'unknown']);
const NON_SEMANTIC_TAGS = new Set(['div', 'span', 'section', 'article', 'li', 'p']);
const SECRET_TYPES = new Set(['password']);

interface CdpRunner {
  run<T>(targetId: string, method: string, params: Record<string, unknown>): Promise<T>;
}

interface RuntimeObjectResult {
  result?: {
    objectId?: string;
    subtype?: string;
  };
}

interface AxValue {
  value?: unknown;
}

interface AxNode {
  ignored?: boolean;
  name?: AxValue;
  role?: AxValue;
}

interface PartialAxTreeResult {
  nodes?: unknown;
}

interface AxSemantics {
  name?: string;
  role?: string;
}

export interface AccessibilityEnrichmentOptions {
  /** Maximum controls queried in one snapshot. Clamped to a small hard limit. */
  maxCandidates?: number;
  /** Maximum concurrent CDP lookups. Clamped to the candidate limit. */
  concurrency?: number;
}

export interface AccessibilityEnrichmentResult {
  /** A copy of the input array. Original elements are never mutated. */
  elements: SnapshotElement[];
  /** Controls that passed the selective ambiguity gate and had a known frame. */
  attempted: number;
  /** Controls whose name or role became more useful. */
  enriched: number;
  /** Candidates left out by the per-snapshot bound. */
  truncated: boolean;
}

function boundedInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(maximum, Math.floor(value)));
}

function meaningfulText(value: string): boolean {
  // Punctuation-only controls ("…", "×", an icon glyph) are precisely where
  // the browser's computed accessible name may know more than the DOM text.
  return /[\p{L}\p{N}]/u.test(value);
}

function normalised(value: string): string {
  return value.trim().toLocaleLowerCase();
}

/** Whether a semantic role needs Chrome's computed accessibility answer. */
export function isAmbiguousSemanticRole(role: string, tag: string): boolean {
  const cleanRole = normalised(role);
  const cleanTag = normalised(tag);
  return AMBIGUOUS_ROLES.has(cleanRole) || (cleanRole === cleanTag && NON_SEMANTIC_TAGS.has(cleanTag));
}

/** Whether a semantic name is empty, decorative or merely repeats its type. */
export function isAmbiguousSemanticName(name: string, role: string, tag: string): boolean {
  const cleanName = normalised(name);
  if (!cleanName || !meaningfulText(cleanName)) return true;
  return cleanName === normalised(role) || cleanName === normalised(tag);
}

/** The cheap gate run before any CDP Accessibility request is considered. */
export function needsAccessibilityEnrichment(element: SnapshotElement): boolean {
  if (SECRET_TYPES.has(normalised(element.type ?? ''))) return false;
  if (!REF_SHAPE.test(element.ref)) return false;
  return isAmbiguousSemanticName(element.name, element.role, element.tag) ||
    isAmbiguousSemanticRole(element.role, element.tag);
}

function frameKey(ref: string): string | undefined {
  return REF_SHAPE.exec(ref)?.[1];
}

/**
 * Return the element object rather than page data.
 *
 * Ref values have already passed REF_SHAPE, so they contain no selector
 * metacharacters. Open shadow roots are searched because snapshot handles may
 * live inside them; the walk is bounded so malformed pages cannot turn this
 * fallback into a whole-document crawl without end.
 */
function refObjectExpression(ref: string): string {
  return `(() => {
  const wanted = ${JSON.stringify(ref)};
  const selector = '[' + ${JSON.stringify(REF_ATTRIBUTE)} + '="' + wanted + '"]';
  const roots = [document];
  for (let rootIndex = 0; rootIndex < roots.length && rootIndex < 128; rootIndex++) {
    const root = roots[rootIndex];
    const direct = root.querySelector && root.querySelector(selector);
    if (direct) return direct;
    const descendants = root.querySelectorAll ? root.querySelectorAll('*') : [];
    for (let index = 0; index < descendants.length && index < 5000; index++) {
      if (descendants[index].shadowRoot) roots.push(descendants[index].shadowRoot);
    }
  }
  return null;
})()`;
}

function axString(value: AxValue | undefined, limit: number): string | undefined {
  if (typeof value?.value !== 'string') return undefined;
  const clean = value.value.replace(/\s+/g, ' ').trim();
  return clean ? clean.slice(0, limit) : undefined;
}

function firstAxNode(value: unknown): AxNode | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  // fetchRelatives:false asks Chrome for the addressed node alone. Trust only
  // that first node even if an implementation sends unexpected extra entries;
  // taking an ancestor could rename a button after the region around it.
  const first = value[0];
  return first && typeof first === 'object' ? first as AxNode : undefined;
}

function readSemantics(value: PartialAxTreeResult): AxSemantics | undefined {
  const node = firstAxNode(value.nodes);
  if (!node || node.ignored === true) return undefined;
  const name = axString(node.name, MAX_AX_NAME);
  const role = axString(node.role, MAX_AX_ROLE);
  return name || role ? { ...(name ? { name } : {}), ...(role ? { role } : {}) } : undefined;
}

async function semanticsFor(
  manager: CdpRunner,
  tabId: string,
  context: FrameContext,
  ref: string
): Promise<AxSemantics | undefined> {
  const runOn = context.runOn ?? tabId;
  let objectId: string | undefined;
  try {
    const object = await manager.run<RuntimeObjectResult>(runOn, 'Runtime.evaluate', {
      expression: refObjectExpression(ref),
      contextId: context.contextId,
      returnByValue: false,
      silent: true
    });
    objectId = object.result?.subtype === 'null' ? undefined : object.result?.objectId;
    if (!objectId) return undefined;

    const partial = await manager.run<PartialAxTreeResult>(runOn, 'Accessibility.getPartialAXTree', {
      objectId,
      fetchRelatives: false
    });
    // Deliberately extract only name and role. AX values, descriptions,
    // properties and user-entered content never cross this module's boundary.
    return readSemantics(partial);
  } catch {
    // Accessibility is an optional refinement. An older browser, a stale
    // execution context or a disappearing node must not invalidate the DOM
    // snapshot that already succeeded.
    return undefined;
  } finally {
    if (objectId) {
      try {
        await manager.run(runOn, 'Runtime.releaseObject', { objectId });
      } catch {
        // Releasing a handle from a document that navigated is already done by
        // Chrome. Nothing about the ordinary snapshot depends on cleanup.
      }
    }
  }
}

function applySemantics(element: SnapshotElement, semantics: AxSemantics | undefined): SnapshotElement {
  if (!semantics) return element;
  const role = semantics.role && !isAmbiguousSemanticRole(semantics.role, element.tag)
    ? semantics.role
    : undefined;
  const comparisonRole = role ?? element.role;
  const name = semantics.name && !isAmbiguousSemanticName(semantics.name, comparisonRole, element.tag)
    ? semantics.name
    : undefined;

  const useRole = isAmbiguousSemanticRole(element.role, element.tag) ? role : undefined;
  const useName = isAmbiguousSemanticName(element.name, element.role, element.tag) ? name : undefined;
  if (!useRole && !useName) return element;
  return { ...element, ...(useRole ? { role: useRole } : {}), ...(useName ? { name: useName } : {}) };
}

async function mapLimited<T, R>(values: T[], limit: number, work: (value: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < values.length) {
      const index = next++;
      results[index] = await work(values[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker));
  return results;
}

/**
 * Enrich only ambiguous controls with a bounded partial AX lookup.
 *
 * The caller supplies the frame contexts used by the snapshot so a ref cannot
 * be looked up in a newly numbered document. Any missing frame, stale node or
 * CDP failure leaves the corresponding SnapshotElement byte-for-byte intact.
 */
export async function enrichAmbiguousElementsWithAccessibility(
  manager: BrowserManager,
  tabId: string,
  contexts: FrameContext[],
  elements: SnapshotElement[],
  options: AccessibilityEnrichmentOptions = {}
): Promise<AccessibilityEnrichmentResult> {
  const maximum = boundedInteger(options.maxCandidates, DEFAULT_MAX_CANDIDATES, HARD_MAX_CANDIDATES);
  const contextsByKey = new Map(contexts.map((context) => [context.key, context]));
  const eligible = elements
    .map((element, index) => ({ element, index, context: contextsByKey.get(frameKey(element.ref) ?? '') }))
    .filter((entry): entry is typeof entry & { context: FrameContext } =>
      Boolean(entry.context) && needsAccessibilityEnrichment(entry.element)
    );
  const candidates = eligible.slice(0, maximum);
  const concurrency = boundedInteger(options.concurrency, DEFAULT_CONCURRENCY, maximum);

  const answers = await mapLimited(candidates, concurrency, async (candidate) => ({
    ...candidate,
    semantics: await semanticsFor(manager, tabId, candidate.context, candidate.element.ref)
  }));

  const output = elements.map((element) => ({ ...element }));
  let enriched = 0;
  for (const answer of answers) {
    const replacement = applySemantics(answer.element, answer.semantics);
    if (replacement !== answer.element) enriched++;
    output[answer.index] = { ...replacement };
  }

  return {
    elements: output,
    attempted: candidates.length,
    enriched,
    truncated: eligible.length > candidates.length
  };
}
