import { estimateTokens } from './tokens';
import type { MessageContent } from './messageContent';
import { messageContentToText, countImageParts, isFileAttachmentPart } from './messageContent';

/**
 * Keeps a long run inside the model's context window.
 *
 * Compaction was measured once, before the loop started, against the messages
 * carried in from the session. Nothing measured the context the loop itself
 * builds, and that is the one that grows: every tool result is appended in
 * full, and a run that reads a 106 KB file several times adds it several
 * times. A recorded audit run ended on `API error 400: this endpoint's
 * maximum context length is 256000 tokens` — the loop had walked into the
 * wall with no check between it and the provider.
 *
 * Trimming here is deliberately local and synchronous. Summarising mid-run
 * would mean an extra API call at exactly the moment the run is already in
 * trouble, and a failed summary would leave the context in a worse state than
 * it started. Old tool payloads are the bulk of the growth and the least
 * useful part to keep verbatim, so those are what gets replaced — by a stub,
 * in place, so that every tool result still answers its tool call and the
 * request stays well-formed.
 */

/** Fraction of the window at which old tool payloads start being replaced. */
export const PRUNE_AT_FRACTION = 0.7;

/**
 * The most context worth carrying, whatever the window allows.
 *
 * The window is how much a model *can* be sent. It is not how much it is
 * worth paying to send, and the two were the same number here: pruning began
 * at 0.7 of the window, so a model catalogued at a million tokens carried
 * seven hundred thousand before anything was trimmed — and every turn resends
 * all of it.
 *
 * Measured on a real session: 258,000 tokens of context, of which 82% was
 * old tool results — page reads the run had already acted on and would never
 * look at again. The operator's own words were a tenth of one percent. At the
 * window-derived threshold none of it was trimmed; at this ceiling most of it
 * is, and nothing the run is still reasoning about is touched: the most recent
 * results are kept whole and only older payloads become excerpts.
 *
 * A larger window is still worth having — it is the room to read a big page
 * without failing. It is not a budget to spend by default.
 */
export const WORKING_CONTEXT_CEILING = 120_000;

/** Where trimming starts for this model: the smaller of the two. */
export function pruneThreshold(modelCtx: number): number {
  return Math.min(Math.floor(modelCtx * PRUNE_AT_FRACTION), WORKING_CONTEXT_CEILING);
}
/**
 * Where the shortened history ends, and why it moves in jumps.
 *
 * Providers price a cached prompt at a fiftieth of a fresh one, and the cache
 * is keyed on the prefix: byte-identical from the start, or nothing. Shortening
 * a payload rewrites the middle of that prefix, so everything after it is paid
 * for again at full rate.
 *
 * The window of results kept whole used to slide by one every turn, so one more
 * message was rewritten every turn and the prefix never held still. It is
 * visible in a real run: while the context sat under the ceiling the cache
 * carried 97.7% of the prompt and 1,852 tokens were fresh; from the turn the
 * ceiling was crossed, 33,398 were — eighteen times more, for two hundred and
 * fifty turns, with no more information reaching the model.
 *
 * A frontier fixes that. It advances only when the context is over the
 * threshold, never retreats, and everything before it stays shortened exactly
 * as it was. Between advances the prefix only grows at the end, which is what
 * a cache can follow. It also keeps *more* history whole than the sliding
 * window did: a payload ages out at the next advance rather than at the next
 * turn.
 */
export const NO_COLLAPSE = 0;

/**
 * Where the frontier should stand this turn.
 *
 * Under pressure it moves up to the current working set and stops; otherwise it
 * stays exactly where it was. It never moves back, because un-shortening a
 * payload would rewrite the prefix in the other direction and cost the same.
 */
export function advanceCollapseFrontier<T extends { role: string }>(
  entries: T[],
  previous: number,
  underPressure: boolean,
  keepRecent = KEEP_RECENT_TOOL_PAYLOADS
): number {
  if (!underPressure) return previous;
  const tools = entries.filter((entry) => entry.role === 'tool').length;
  // Counted in tool results rather than array positions, so the same frontier
  // means the same thing whether it is applied to the stored history or to the
  // in-flight context, which differ by whatever else sits between them.
  return Math.max(previous, Math.max(0, tools - keepRecent));
}

/**
 * Shorten the history up to the frontier, or leave it exactly as it is.
 *
 * One place, because the three callers in the agent loop had the same eight
 * lines each and a rule that lives in three copies is a rule that will soon
 * live in two.
 */
export function applyCollapse<T extends { role: string; content: MessageContent }>(
  entries: T[],
  frontier: number
): void {
  if (frontier <= 0) return;
  collapseHistoricalToolPayloads(entries, frontier);
  collapseHistoricalFileAttachments(entries);
}

/** Most recent tool results to leave untouched — the ones still being reasoned about. */
export const KEEP_RECENT_TOOL_RESULTS = 6;
/** Full payloads older than this are excerpts once they leave the working set. */
export const MAX_HISTORICAL_TOOL_RESULT_CHARS = 1_600;
/** A little wider than the hard-prune window: enough for the current subtask. */
export const KEEP_RECENT_TOOL_PAYLOADS = 8;
/** Keep document text through the active task; age it out only under pressure. */
export const KEEP_RECENT_ATTACHMENT_ENTRIES = 16;

export interface ContextEntry {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: MessageContent;
  tool_call_id?: string;
  name?: string;
  tool_calls?: unknown;
  provider_state?: unknown;
}

function excerpt(text: string, limit = MAX_HISTORICAL_TOOL_RESULT_CHARS): string {
  if (text.length <= limit) return text;
  const head = Math.floor(limit * 0.72);
  const tail = limit - head;
  return `${text.slice(0, head)}\n…[middle omitted]…\n${text.slice(-tail)}`;
}

/**
 * Keep the recent tool working set verbatim and turn older payloads into useful
 * excerpts before asking a model to summarise anything.
 *
 * A page_read result contains the formatted page in `message` and the same
 * snapshot again in `data`. In the measured job-search session, 140 reads
 * occupied 3.89M characters; 67% was this duplicate structured copy. Passing
 * all of it to the summariser spends a large-model request merely describing
 * stale pages. Claude Code follows the same broad order: clear older tool
 * outputs first, then compact the conversation only if it is still large.
 *
 * The replacement keeps success/failure, a head-and-tail excerpt, the original
 * size, and the call/result position. Recent results remain complete, so the
 * model still has exact evidence for the work it is actively doing.
 */
export function collapseHistoricalToolPayloads<T extends { role: string; content: MessageContent }>(
  entries: T[],
  upToToolResults: number
): number {
  const toolIndexes = entries
    .map((entry, index) => (entry.role === 'tool' ? index : -1))
    .filter((index) => index >= 0);
  const candidates = toolIndexes.slice(0, Math.max(0, upToToolResults));
  let collapsed = 0;

  for (const index of candidates) {
    const entry = entries[index];
    if (!entry) continue;
    const original = typeof entry.content === 'string'
      ? entry.content
      : messageContentToText(entry.content);
    if (original.length <= MAX_HISTORICAL_TOOL_RESULT_CHARS) continue;
    if (original.includes('[historical tool result shortened from')) continue;

    let useful = original;
    let success: unknown = true;
    try {
      const parsed = JSON.parse(original) as Record<string, unknown>;
      success = parsed.success ?? true;
      const message = typeof parsed.message === 'string' ? parsed.message.trim() : '';
      const data = typeof parsed.data === 'string' ? parsed.data.trim() : '';
      // A fetch/read often puts the short status in message and the evidence in
      // data. Preserve both; page_read's structured data is an object duplicate
      // and is intentionally ignored in favour of its complete message.
      if (data) useful = message ? `${message}\n${data}` : data;
      else if (message) useful = message;
    } catch {
      // Plain tool text is excerpted directly.
    }

    entry.content = JSON.stringify({
      success,
      message: `[historical tool result shortened from ${original.length} characters; re-run the tool if exact old details matter]\n${excerpt(useful)}`
    });
    collapsed++;
  }

  return collapsed;
}

/**
 * A file attachment remains visible as a path/card after its extracted text
 * leaves active context. Exact details stay recoverable through resume_read.
 */
export function collapseHistoricalFileAttachments<T extends { content: MessageContent }>(
  entries: T[],
  keepRecentEntries = KEEP_RECENT_ATTACHMENT_ENTRIES
): number {
  const cutoff = Math.max(0, entries.length - keepRecentEntries);
  let collapsed = 0;
  for (let index = 0; index < cutoff; index++) {
    const entry = entries[index];
    if (!entry || !Array.isArray(entry.content)) continue;
    let changed = false;
    const parts = entry.content.map((part) => {
      if (!isFileAttachmentPart(part) || part.file_attachment.omitted || !part.file_attachment.text) return part;
      changed = true;
      collapsed++;
      return {
        ...part,
        file_attachment: { ...part.file_attachment, text: '', omitted: true }
      };
    });
    if (changed) entry.content = parts;
  }
  return collapsed;
}

/** Rough token cost of one screenshot image in a multimodal message.
 *
 * The text estimator counts an image as the words "[1 image attachment]"
 * (~3 tokens), but vision models bill images by tile or pixel budget. A
 * 1920x1080 screenshot can run to several thousand tokens on providers that
 * use 512x512 tiles. Using a conservative flat rate keeps the context window
 * honest when desktop automation is active.
 */
const IMAGE_TOKEN_ESTIMATE = 3_000;

export function estimateContextTokens(context: ContextEntry[]): number {
  return context.reduce((total, entry) => {
    const text = typeof entry.content === 'string'
      ? entry.content
      : messageContentToText(entry.content);
    const callsText = entry.tool_calls ? JSON.stringify(entry.tool_calls) : '';
    const images = typeof entry.content === 'string' ? 0 : countImageParts(entry.content);
    // provider_state is replayed verbatim by the Anthropic and Responses
    // adapters — a signed thinking block or an encrypted reasoning item is
    // protocol-mandatory on the next turn, so it is real billed input. Not
    // counting it was the same blind spot as unpriced base64: the estimator
    // says the context fits while the provider disagrees.
    const stateText = entry.provider_state ? JSON.stringify(entry.provider_state) : '';
    return total + estimateTokens(text) + estimateTokens(callsText) + estimateTokens(stateText) + images * IMAGE_TOKEN_ESTIMATE;
  }, 0);
}

export interface PruneOutcome {
  /** Whether anything was replaced. */
  pruned: boolean;
  /** Tool results whose payload was replaced by a stub. */
  prunedCount: number;
  /** Estimated tokens before and after. */
  before: number;
  after: number;
}

/**
 * Replace the payload of older tool results until the context fits the limit.
 *
 * The recent window protects the results the model is still reasoning about.
 * When stubbing everything outside that window is still not enough — an
 * estimator that undercounted, a run of enormous reads close together — the
 * window gives way down to the single newest result: a stub is shape-safe
 * (the tool_call_id pairing survives), while a request the provider refuses
 * is the end of the run. Returns how many payloads were replaced.
 */
function stubOldToolPayloads(context: ContextEntry[], limit: number, keepRecent: number): number {
  const toolIndexes = context
    .map((entry, index) => (entry.role === 'tool' ? index : -1))
    .filter((index) => index >= 0);
  const prunable = toolIndexes.slice(0, Math.max(0, toolIndexes.length - keepRecent));

  let prunedCount = 0;
  for (const index of prunable) {
    const entry = context[index];
    if (!entry) continue;
    const text = typeof entry.content === 'string' ? entry.content : messageContentToText(entry.content);
    const stub = JSON.stringify({
      success: true,
      message: '[earlier tool result dropped to stay inside the context window; re-read it only if the answer depends on it]'
    });
    // Already a stub, or too small to be worth replacing.
    if (text === stub || estimateTokens(text) < 50) continue;
    entry.content = stub;
    prunedCount++;
    if (estimateContextTokens(context) <= limit) break;
  }
  return prunedCount;
}

/**
 * Replace the payload of older tool results when the context grows too large.
 *
 * Mutates in place: the array is the live context of a running turn, and the
 * caller keeps appending to it.
 */
export function pruneContextIfNeeded(context: ContextEntry[], modelCtx: number): PruneOutcome {
  const before = estimateContextTokens(context);
  const limit = pruneThreshold(modelCtx);
  if (before <= limit) {
    return { pruned: false, prunedCount: 0, before, after: before };
  }

  let prunedCount = stubOldToolPayloads(context, limit, KEEP_RECENT_TOOL_RESULTS);
  if (estimateContextTokens(context) > limit) {
    // First pass was not enough. Being inside the window matters less than
    // the request being sendable at all.
    prunedCount += stubOldToolPayloads(context, limit, 1);
  }

  return { pruned: prunedCount > 0, prunedCount, before, after: estimateContextTokens(context) };
}
