// evidence.ts - what the browser actually proved about one item of work.
//
// A confirmation from another tab, or from the previous vacancy in this tab,
// is not evidence for the application being recorded now. The browser tools
// therefore keep the stable tab id, the tab reference the run used, and the
// vacancy identity that was open when the confirmation was observed.

export interface Evidence {
  /** What was observed, in the page's own words where possible. */
  what: string;
  /** True only when the page changed into this state while being watched. */
  confirmed: boolean;
  /** Stable browser tab id. */
  tabId: string;
  /** Vacancy or other work item that was active when this was observed. */
  itemUrl?: string;
  itemKey?: string;
  /** Page on which the words themselves were observed. */
  observedUrl?: string;
  at: number;
}

export type RecentEvidence = Omit<Evidence, 'at'> & { ageMs: number };

export interface ReviewEvidence {
  tabId: string;
  itemUrl: string;
  /**
   * The stable identity of the vacancy, where the URL has one.
   *
   * Absent for every site whose job pages are not shaped like a job board's —
   * a company careers page at `acme.com/careers/senior-engineer` has no id to
   * extract. Those are matched by their exact URL instead, which is stricter
   * than a key rather than looser: a key deliberately treats two spellings of
   * one vacancy as the same page, and an exact URL treats nothing as the same
   * but itself.
   */
  itemKey?: string;
  text: string;
  /** Title/heading of the selected vacancy, excluding other cards in the list. */
  identity: string;
  at: number;
}

export type RecentReview = Omit<ReviewEvidence, 'at'> & { ageMs: number };

/**
 * Said at the moment a confirmation is witnessed, in the result that saw it.
 *
 * A run that has just sent an application goes looking for the next vacancy
 * and writes its records at the end — and by then there is nothing to write:
 * the proof is tied to this tab and this vacancy, and leaving the page ends
 * it. Watched on 2026-08-23, twice: eighteen page reads carried a line asking
 * for records as they happen, and two real applications were still lost. An
 * advisory at the top of a long read is not read.
 *
 * This one is not an advisory in a wall of page text. It is the last line of
 * the result that just witnessed the thing, at the moment it is true.
 */
export const RECORD_IT_NOW =
  ' Record it now with task_done, naming this tab and this vacancy: the proof lives on this tab and this page only, ' +
  'and opening the next vacancy ends it. Not at the end of the run — now.';

const seen = new Map<string, Evidence>();
const reviewed = new Map<string, ReviewEvidence>();
const tabAliases = new Map<string, string>();
const activeItems = new Map<string, { url: string; key?: string }>();

/** How long an observation is about the item being recorded now. */
const STILL_ABOUT_THIS_ITEM_MS = 5 * 60 * 1000;

function normaliseUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|trk|tracking|ref|source)/i.test(key)) url.searchParams.delete(key);
    }
    url.hostname = url.hostname.toLowerCase();
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    return url.toString();
  } catch {
    return undefined;
  }
}

/**
 * A stable identity for a vacancy URL, including the post-apply LinkedIn URL.
 * The fallback deliberately applies only to job-shaped paths: a generic
 * /thank-you page must not replace the vacancy that led to it.
 */
export function workItemKey(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }

  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  for (const name of ['currentJobId', 'jobId', 'job_id', 'jobPostingId', 'postingId', 'gh_jid']) {
    const id = url.searchParams.get(name)?.trim();
    if (id) return `${host}:job:${id.toLowerCase()}`;
  }

  const path = decodeURIComponent(url.pathname).replace(/\/+$/, '');
  const linkedin = /\/jobs\/view\/(\d+)/i.exec(path)?.[1];
  if (linkedin) return `${host}:job:${linkedin}`;

  const workday = /\/job\/[^/]+\/([a-z]*\d[\w-]*)$/i.exec(path)?.[1];
  if (workday) return `${host}:job:${workday.toLowerCase()}`;

  const jobPath = /\/(?:jobs?|positions?|vacancies|requisitions?)\/(?:view\/)?([^/?#]+)(?:\/([^/?#]+))?$/i.exec(path);
  if (jobPath && !/^(apply|application|success|submitted|thank(?:-?you)?)$/i.test(jobPath[1]!)) {
    return `${host}:path:${path.toLowerCase()}`;
  }
  return undefined;
}

function rememberAlias(tabId: string, alias?: string): void {
  tabAliases.set(tabId, tabId);
  const trimmed = alias?.trim();
  if (trimmed) tabAliases.set(trimmed, tabId);
}

/** Remember which vacancy is currently being worked on in a tab. */
export function notePage(tabId: string, url: string | undefined, tabAlias?: string): void {
  rememberAlias(tabId, tabAlias);
  if (!url) return;
  const normalised = normaliseUrl(url);
  if (!normalised) return;

  const key = workItemKey(normalised);
  const current = activeItems.get(tabId);
  if (key) {
    if (current?.key && current.key !== key) {
      seen.delete(tabId);
      reviewed.delete(tabId);
    }
    activeItems.set(tabId, { url: normalised, key });
    return;
  }

  // A confirmation route on the same site belongs to the active vacancy. A
  // navigation to another site does not.
  //
  // Only while a specific vacancy is being worked on, though. Held open for a
  // keyless page as well, this pinned the tab to whichever address it saw
  // first: every later page on the same site was read while the record still
  // said the earlier one, so a review stored the wrong URL and the vacancy
  // actually on screen could never be recorded.
  if (current) {
    // The same address is the same page. Every click and every wait reports
    // where it happened, so without this the ordinary work of filling a form
    // threw away the read that had just been taken of it.
    if (current.url === normalised) return;
    try {
      if (current.key && new URL(current.url).origin === new URL(normalised).origin) return;
    } catch {
      // Both values were already parsed above; this is only defensive.
    }
    seen.delete(tabId);
    reviewed.delete(tabId);
  }
  activeItems.set(tabId, { url: normalised });
}

/** Remember a successful full read of the vacancy, separately from submission proof. */
export function noteReviewedPage(
  tabId: string,
  url: string,
  text: string,
  tabAlias?: string,
  identity = text
): void {
  notePage(tabId, url, tabAlias);
  const item = activeItems.get(tabId);
  const trimmed = text.trim();
  // Was `if (!item?.key)`, and that one word cost every application outside a
  // handful of job boards. A vacancy whose URL yields no key stored no review
  // at all, so task_done answered "no recent full page_read exists for that
  // vacancy in that tab" however many times the page was read — and the run's
  // only way out was to record the application as skipped or failed. It read
  // as a cautious model; it was a recorder that could not be satisfied.
  if (!item || !trimmed) return;
  reviewed.set(tabId, {
    tabId,
    itemUrl: item.url,
    ...(item.key ? { itemKey: item.key } : {}),
    text: trimmed.slice(0, 80_000),
    identity: identity.trim().slice(0, 2_000),
    at: Date.now()
  });
}

export function noteSeen(
  tabId: string,
  what: string,
  confirmed: boolean,
  options: { url?: string; tabAlias?: string } = {}
): void {
  const trimmed = what.trim().slice(0, 160);
  if (!trimmed) return;
  notePage(tabId, options.url, options.tabAlias);
  const item = activeItems.get(tabId);
  const previous = seen.get(tabId);
  const sameItem = previous?.itemKey && item?.key
    ? previous.itemKey === item.key
    : previous?.itemUrl !== undefined && previous.itemUrl === item?.url;
  // A later read describes a state; it does not undo the fact that this same
  // tab and vacancy were already observed changing into confirmation. Job
  // boards commonly replace /jobs/view/123 with /jobs/search-results?jobId=123
  // after submission; the stable work-item key, not the route spelling, is
  // what proves both pages belong to the same vacancy.
  if (
    !confirmed &&
    previous?.confirmed &&
    sameItem
  ) return;
  seen.set(tabId, {
    what: trimmed,
    confirmed,
    tabId,
    ...(item?.url ? { itemUrl: item.url } : {}),
    ...(item?.key ? { itemKey: item.key } : {}),
    ...(options.url ? { observedUrl: options.url } : {}),
    at: Date.now()
  });
}

export function forgetSeen(tabId?: string): void {
  if (tabId === undefined) {
    seen.clear();
    reviewed.clear();
    tabAliases.clear();
    activeItems.clear();
    return;
  }
  const stable = tabAliases.get(tabId) ?? tabId;
  seen.delete(stable);
  reviewed.delete(stable);
  activeItems.delete(stable);
  for (const [alias, id] of tabAliases) {
    if (id === stable) tabAliases.delete(alias);
  }
}

function recent(note: Evidence | undefined, now: number): RecentEvidence | undefined {
  if (!note) return undefined;
  const ageMs = now - note.at;
  if (ageMs > STILL_ABOUT_THIS_ITEM_MS) return undefined;
  const { at: _at, ...rest } = note;
  return { ...rest, ageMs };
}

/** Most recent observation across tabs, retained for non-browser work reports. */
export function latestEvidence(now = Date.now()): RecentEvidence | undefined {
  let best: Evidence | undefined;
  for (const note of seen.values()) {
    if (!best || note.at >= best.at) best = note;
  }
  return recent(best, now);
}

export type EvidenceVerdict =
  | { ok: true; evidence: RecentEvidence }
  | { ok: false; reason: string };

export type ReviewVerdict =
  | { ok: true; evidence: RecentReview }
  | { ok: false; reason: string };

const SUBJECT_FILLER = new Set([
  'at', 'in', 'for', 'the', 'and', 'with', 'remote', 'job', 'role',
  'в', 'на', 'для', 'и', 'вакансия', 'работа'
]);

function subjectWords(value: string): string[] {
  return [...new Set(value
    .toLowerCase()
    .split(/[^\p{L}\p{N}+#]+/u)
    .filter((word) => word.length >= 2 && !SUBJECT_FILLER.has(word))
  )];
}

function subjectMatchesPage(subject: string, text: string): boolean {
  const wanted = subjectWords(subject);
  if (wanted.length === 0) return false;
  const present = new Set(subjectWords(text));
  const hits = wanted.filter((word) => present.has(word)).length;
  return hits >= Math.min(2, wanted.length) && hits / wanted.length >= 0.65;
}

/** Proof that this exact vacancy, not merely its list row, was actually read. */
export function verifiedReview(
  tabRef: string,
  claimedUrl: string,
  subject: string,
  now = Date.now()
): ReviewVerdict {
  const tabId = tabAliases.get(tabRef.trim()) ?? tabRef.trim();
  const note = reviewed.get(tabId);
  if (!note || now - note.at > STILL_ABOUT_THIS_ITEM_MS) {
    return { ok: false, reason: 'no recent full page_read exists for that vacancy in that tab' };
  }
  const claimedKey = workItemKey(claimedUrl);
  if (claimedKey || note.itemKey) {
    if (claimedKey !== note.itemKey) {
      return { ok: false, reason: 'the URL being recorded belongs to a different vacancy than the one read in that tab' };
    }
  } else {
    // Neither side has an id to compare, so the address itself is the
    // identity, and it has to be the same address.
    const claimed = normaliseUrl(claimedUrl);
    if (!claimed) return { ok: false, reason: 'the application URL is not a valid absolute URL' };
    if (claimed !== note.itemUrl) {
      return { ok: false, reason: 'the URL being recorded is not the page that was read in that tab' };
    }
  }
  if (!subjectMatchesPage(subject, note.identity)) {
    return {
      ok: false,
      reason: `the subject "${subject}" does not match the title and company on the vacancy that was read`
    };
  }
  const { at: _at, ...rest } = note;
  return { ok: true, evidence: { ...rest, ageMs: now - note.at } };
}

/** Words that explicitly say a job application was accepted by the site. */
export function isSubmissionConfirmation(value: string): boolean {
  const text = value.toLowerCase().replace(/\s+/gu, ' ').trim();
  return [
    /\bapplication\b.{0,35}\b(submitted|sent|received|successful)\b/i,
    /\b(successfully|you(?:'ve| have))\s+applied\b/i,
    /\bthank(?:s| you)\b.{0,30}\b(applying|application)\b/i,
    /\b(submitted|sent)\s+successfully\b/i,
    /заявк[аиу].{0,35}(отправлен[ао]?|подан[ао]?|принят[ао]?)/iu,
    /отклик.{0,35}(отправлен|подан|принят)/iu,
    /вы\s+откликнулись/iu,
    /\b(bewerbung|bewerbung wurde)\b.{0,35}\b(gesendet|eingereicht|erfolgreich)\b/i,
    /\b(solicitud|candidatura)\b.{0,35}\b(enviada|presentada|recibida)\b/i
  ].some((pattern) => pattern.test(text));
}

/** Proof for exactly the tab and vacancy a `task_done` call names. */
export function verifiedEvidence(tabRef: string, claimedUrl: string, now = Date.now()): EvidenceVerdict {
  const tabId = tabAliases.get(tabRef.trim()) ?? tabRef.trim();
  const evidence = recent(seen.get(tabId), now);
  if (!evidence) {
    return { ok: false, reason: 'no recent browser evidence exists for that tab' };
  }
  if (!evidence.confirmed) {
    return { ok: false, reason: `the tab was only seen showing "${evidence.what}"; it was not observed changing into a confirmation` };
  }
  if (!isSubmissionConfirmation(evidence.what)) {
    return {
      ok: false,
      reason: `the observed change "${evidence.what}" does not explicitly say the application was sent or received`
    };
  }

  const claimedKey = workItemKey(claimedUrl);
  if (claimedKey && evidence.itemKey && claimedKey !== evidence.itemKey) {
    return { ok: false, reason: 'the confirmation belongs to a different vacancy in that tab' };
  }

  const claimed = normaliseUrl(claimedUrl);
  if (!claimed) return { ok: false, reason: 'the application URL is not a valid absolute URL' };
  if (!claimedKey && evidence.itemUrl && claimed !== evidence.itemUrl) {
    return { ok: false, reason: 'the confirmation is not tied to the URL being recorded' };
  }
  if (claimedKey && !evidence.itemKey) {
    return { ok: false, reason: 'the tab was not read while that vacancy was active' };
  }
  return { ok: true, evidence };
}

/** Explicit submitted/applied status currently visible on this exact vacancy. */
export function verifiedVisibleSubmission(tabRef: string, claimedUrl: string, now = Date.now()): EvidenceVerdict {
  const tabId = tabAliases.get(tabRef.trim()) ?? tabRef.trim();
  const evidence = recent(seen.get(tabId), now);
  if (!evidence) return { ok: false, reason: 'no recent browser evidence exists for that tab' };
  if (!isSubmissionConfirmation(evidence.what)) {
    return { ok: false, reason: `the page does not explicitly show a sent/submitted status for this vacancy` };
  }
  const claimedKey = workItemKey(claimedUrl);
  if (!claimedKey || !evidence.itemKey || claimedKey !== evidence.itemKey) {
    return { ok: false, reason: 'the visible submitted status belongs to a different vacancy' };
  }
  return { ok: true, evidence };
}

/** A human-readable line for the work log. */
export function describeEvidence(evidence = latestEvidence()): string | undefined {
  if (!evidence) return undefined;
  const seconds = Math.round(evidence.ageMs / 1000);
  const when = seconds < 90 ? `${seconds}s earlier` : `${Math.round(seconds / 60)}min earlier`;
  return evidence.confirmed
    ? `the page showed "${evidence.what}" ${when}, having changed into it`
    : `no confirmation was seen; the page showed "${evidence.what}" ${when}`;
}

export function describeExistingSubmission(evidence: RecentEvidence): string {
  const seconds = Math.round(evidence.ageMs / 1000);
  const when = seconds < 90 ? `${seconds}s earlier` : `${Math.round(seconds / 60)}min earlier`;
  return `the page currently showed "${evidence.what}" ${when} (verified existing account status)`;
}
