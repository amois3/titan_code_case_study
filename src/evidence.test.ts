import { describe, it, expect, beforeEach } from 'vitest';

import {
  describeEvidence,
  forgetSeen,
  isSubmissionConfirmation,
  latestEvidence,
  notePage,
  noteReviewedPage,
  noteSeen,
  verifiedEvidence,
  verifiedReview,
  verifiedVisibleSubmission,
  workItemKey
} from './evidence';

beforeEach(() => {
  forgetSeen();
});

/**
 * Seven applications recorded in one hour, and the operator found one or two in
 * their account. Every record was written in good faith by a run whose own
 * tools had told it the page said "sent".
 *
 * The tools tell the truth now. What the record still lacked was the evidence
 * itself — so it carries it, and the difference between "the page changed into
 * this" and "the page was showing this" is carried with it, because that is
 * exactly the difference between an application sent and one recorded.
 */
describe('what the page was seen to show', () => {
  it('says a confirmation that arrived while being watched', () => {
    noteSeen('tab-1', 'Заявка отправлена', true);

    const said = describeEvidence();
    expect(said).toContain('Заявка отправлена');
    expect(said).toContain('having changed into it');
  });

  it('says plainly when nothing was seen to confirm it', () => {
    noteSeen('tab-1', 'Подать заявку в компанию SCC', false);

    const said = describeEvidence();
    expect(said).toContain('no confirmation was seen');
    expect(said).toContain('Подать заявку');
  });

  it('has nothing to say when nothing was seen', () => {
    expect(latestEvidence()).toBeUndefined();
    expect(describeEvidence()).toBeUndefined();
  });

  it('takes the most recent observation, whichever tab it was in', () => {
    // task_done takes no tab: it records an item of work, not a page. A run
    // that applied in the second tab would otherwise record nothing at all.
    noteSeen('tab-1', 'first', true);
    noteSeen('tab-2', 'second', true);

    expect(describeEvidence()).toContain('second');
  });

  /**
   * An observation from twenty minutes ago is not about the item being recorded
   * now. Carrying it forward would put a real confirmation against an
   * application that never got one, which is worse than carrying nothing.
   */
  it('will not speak for an item it did not watch', () => {
    noteSeen('tab-1', 'Заявка отправлена', true);

    const later = Date.now() + 6 * 60 * 1000;
    expect(latestEvidence(later)).toBeUndefined();
  });

  it('is still about the item a minute later', () => {
    noteSeen('tab-1', 'Заявка отправлена', true);

    expect(latestEvidence(Date.now() + 60 * 1000)?.what).toBe('Заявка отправлена');
  });

  it('says how long ago, in the units a person reads', () => {
    noteSeen('tab-1', 'Заявка отправлена', true);

    expect(describeEvidence({ what: 'x', confirmed: true, tabId: 'tab-1', ageMs: 12000 })).toContain('12s earlier');
    expect(describeEvidence({ what: 'x', confirmed: true, tabId: 'tab-1', ageMs: 200000 })).toContain('3min earlier');
  });

  it('forgets one tab without forgetting another', () => {
    noteSeen('tab-1', 'first', true);
    forgetSeen('tab-1');

    expect(latestEvidence()).toBeUndefined();

    noteSeen('tab-2', 'second', true);
    forgetSeen('tab-1');
    expect(latestEvidence()?.what).toBe('second');
  });

  it('ignores an empty observation rather than recording a blank', () => {
    noteSeen('tab-1', '   ', true);

    expect(latestEvidence()).toBeUndefined();
  });

  it('keeps a long dialog name short enough to read', () => {
    noteSeen('tab-1', 'x'.repeat(500), true);

    expect(latestEvidence()!.what.length).toBeLessThanOrEqual(160);
  });
});

describe('evidence for one exact application', () => {
  const first = 'https://www.linkedin.com/jobs/view/111?trk=feed';
  const second = 'https://www.linkedin.com/jobs/view/222';

  it('accepts confirmation from the same tab and vacancy', () => {
    notePage('stable-tab', first, '0');
    noteSeen('stable-tab', 'Application sent', true, { url: first, tabAlias: '0' });

    expect(verifiedEvidence('0', first).ok).toBe(true);
  });

  it('rejects a real confirmation from another tab', () => {
    notePage('tab-1', first, '0');
    noteSeen('tab-1', 'Application sent', true, { url: first, tabAlias: '0' });

    const verdict = verifiedEvidence('tab-2', first);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toContain('that tab');
  });

  it('rejects confirmation left over from the previous vacancy', () => {
    notePage('tab-1', first, '0');
    noteSeen('tab-1', 'Application sent', true, { url: first, tabAlias: '0' });

    const verdict = verifiedEvidence('0', second);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toContain('different vacancy');
  });

  it('clears old confirmation when a different vacancy is read in the tab', () => {
    notePage('tab-1', first, '0');
    noteSeen('tab-1', 'Application sent', true, { url: first, tabAlias: '0' });
    notePage('tab-1', second, '0');

    expect(verifiedEvidence('0', second).ok).toBe(false);
  });

  it('recognises LinkedIn post-apply and vacancy URLs as the same item', () => {
    const after = 'https://www.linkedin.com/jobs/search/post-apply/default/?currentJobId=111';
    expect(workItemKey(first)).toBe(workItemKey(after));

    notePage('tab-1', first, '0');
    noteSeen('tab-1', 'Application sent', true, { url: after, tabAlias: '0' });
    expect(verifiedEvidence('0', first).ok).toBe(true);
  });

  it('does not treat words that were merely present as proof', () => {
    notePage('tab-1', first, '0');
    noteSeen('tab-1', 'Applied', false, { url: first, tabAlias: '0' });

    const verdict = verifiedEvidence('0', first);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toContain('not observed changing');
  });

  it('rejects an unrelated page change as application proof', () => {
    notePage('tab-1', first, '0');
    noteSeen('tab-1', 'Continue to the next step', true, { url: first, tabAlias: '0' });

    const verdict = verifiedEvidence('0', first);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toContain('does not explicitly say');
  });

  it('recognises explicit confirmations in the languages used by job sites', () => {
    for (const text of [
      'Application submitted',
      'Your application has been received',
      'Thank you for applying',
      'Заявка отправлена',
      'Ваш отклик отправлен',
      'Bewerbung erfolgreich eingereicht'
    ]) expect(isSubmissionConfirmation(text), text).toBe(true);
    expect(isSubmissionConfirmation('Continue to the next step')).toBe(false);
  });

  it('does not downgrade real proof when the confirmed dialog is read afterwards', () => {
    notePage('tab-1', first, '0');
    noteSeen('tab-1', 'Application submitted', true, { url: first, tabAlias: '0' });
    noteSeen('tab-1', 'Application submitted', false, { url: first, tabAlias: '0' });

    expect(verifiedEvidence('0', first).ok).toBe(true);
  });

  it('does not downgrade proof when LinkedIn rewrites the route for the same vacancy', () => {
    const after = 'https://www.linkedin.com/jobs/search-results/?currentJobId=111';
    notePage('tab-1', first, '0');
    noteSeen('tab-1', 'Заявка отправлена', true, { url: first, tabAlias: '0' });

    // This is the exact post-submit sequence: the next page_read sees the
    // confirmation dialog under LinkedIn's search-results route. Merely
    // reading it must not erase the transition witnessed by page_click.
    noteSeen('tab-1', 'Заявка отправлена', false, { url: after, tabAlias: '0' });

    const verdict = verifiedEvidence('0', after);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.evidence.confirmed).toBe(true);
  });
});

describe('evidence that one exact vacancy was reviewed', () => {
  const first = 'https://www.linkedin.com/jobs/view/111';
  const second = 'https://www.linkedin.com/jobs/view/222';

  it('binds the read to its job id and title/company', () => {
    noteReviewedPage('tab-1', first, 'Senior AI Engineer — Quik Hire', '0');
    expect(verifiedReview('0', first, 'Senior AI Engineer at Quik Hire').ok).toBe(true);
  });

  it('rejects another list card recorded under the open vacancy URL', () => {
    noteReviewedPage(
      'tab-1',
      first,
      'Senior AI Engineer — Quik Hire\nMachine Learning Engineer — Eaton\nCloud Engineer — NetApp',
      '0',
      'Senior AI Engineer — Quik Hire'
    );
    const verdict = verifiedReview('0', first, 'Machine Learning Engineer at Eaton');
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toContain('does not match');
  });

  it('rejects a different job id even in the same tab', () => {
    noteReviewedPage('tab-1', first, 'Senior AI Engineer — Quik Hire', '0');
    const verdict = verifiedReview('0', second, 'Senior AI Engineer at Quik Hire');
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toContain('different vacancy');
  });

  it('recognises an explicit already-submitted status without calling it a new transition', () => {
    noteReviewedPage('tab-1', first, 'AI Engineer — Proof IT', '0');
    noteSeen('tab-1', 'Заявка отправлена', false, { url: first, tabAlias: '0' });
    const verdict = verifiedVisibleSubmission('0', first);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.evidence.confirmed).toBe(false);
  });
});

/**
 * The deadlock that recorded a sent application as failed.
 *
 * Replayed from the journal of 2026-09-10, seq 96-123. The run clicked
 * "Отправить заявку", page_wait watched "Заявка отправлена" arrive, and the
 * done record was refused — not for want of proof but because task_done also
 * requires a fresh read of the vacancy itself, and the only way back to it was
 * browser_navigate. Navigating called forgetSeen, which threw the proof away,
 * and the next attempt was refused for having none. The run's escape was to
 * write down the opposite of what happened: outcome "failed" on an application
 * LinkedIn was showing as sent.
 *
 * Wiping on navigation is right when the tab moves to another vacancy — proof
 * for one job must never sign for another. It is wrong when the tab comes back
 * to the same one, and telling those apart is what notePage already does.
 */
describe('coming back to the same vacancy after submitting it', () => {
  const vacancy = 'https://www.linkedin.com/jobs/view/4460977456/';
  const other = 'https://www.linkedin.com/jobs/view/4463449050/';

  function submitted(): void {
    notePage('tab-2', vacancy, '2');
    noteReviewedPage('tab-2', vacancy, 'GenAi Engineer\nLanceSoft Europe\nRemote', '2');
    // page_wait, watching the confirmation arrive: the strongest proof there is.
    noteSeen('tab-2', 'Заявка отправлена', true, { url: vacancy, tabAlias: '2' });
  }

  it('keeps the proof when the tab returns to the vacancy it was proved for', () => {
    submitted();
    expect(verifiedEvidence('2', vacancy).ok).toBe(true);

    // What the run did to satisfy the read-the-vacancy rule.
    notePage('tab-2', vacancy, '2');
    noteReviewedPage('tab-2', vacancy, 'GenAi Engineer\nLanceSoft Europe\nRemote', '2');

    const verdict = verifiedEvidence('2', vacancy);
    expect(verdict.ok).toBe(true);
    expect(verdict.ok && verdict.evidence.what).toBe('Заявка отправлена');
  });

  it('still drops the proof when the tab moves to a different vacancy', () => {
    submitted();
    notePage('tab-2', other, '2');

    expect(verifiedEvidence('2', other).ok).toBe(false);
    // And it cannot be borrowed back for the first one either, because the tab
    // is no longer showing it.
    expect(verifiedEvidence('2', vacancy).ok).toBe(false);
  });
});

/**
 * A vacancy that is not on a job board.
 *
 * "apply on the company site" is where most applications end up, and a company
 * careers page has no id in its URL to extract. The review evidence refused to
 * store anything without one, so task_done answered "no recent full page_read
 * exists for that vacancy in that tab" however many times the page had been
 * read, and the run could record the application only as skipped or failed.
 * Thirty-three checks in the live browser suite were red on this alone.
 */
describe('a vacancy whose URL carries no id', () => {
  const careers = 'https://acme.example/careers/senior-ai-engineer';
  const otherRole = 'https://acme.example/careers/staff-platform-engineer';
  const identity = 'Senior AI Engineer\nAcme\nRiga, hybrid';

  it('records the read, and lets the exact page be recorded', () => {
    expect(workItemKey(careers)).toBeUndefined();

    notePage('tab-1', careers, '1');
    noteReviewedPage('tab-1', careers, identity, '1');

    expect(verifiedReview('1', careers, 'Senior AI Engineer at Acme').ok).toBe(true);
  });

  it('refuses a different page on the same site', () => {
    notePage('tab-1', careers, '1');
    noteReviewedPage('tab-1', careers, identity, '1');

    const verdict = verifiedReview('1', otherRole, 'Staff Platform Engineer at Acme');
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toContain('not the page that was read');
  });

  it('still refuses a subject the page does not support', () => {
    notePage('tab-1', careers, '1');
    noteReviewedPage('tab-1', careers, identity, '1');

    // The looser identity check must not loosen this one: a title read off a
    // search-results card is exactly what this rule exists to catch.
    const verdict = verifiedReview('1', careers, 'Principal Quantitative Researcher at Jane Street');
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toContain('does not match');
  });

  it('follows the tab when it moves to the next role on the same site', () => {
    notePage('tab-1', careers, '1');
    noteReviewedPage('tab-1', careers, identity, '1');

    notePage('tab-1', otherRole, '1');
    noteReviewedPage('tab-1', otherRole, 'Staff Platform Engineer\nAcme\nRiga', '1');

    // The page on screen is the one that can be recorded, and the one left
    // behind is not.
    expect(verifiedReview('1', otherRole, 'Staff Platform Engineer at Acme').ok).toBe(true);
    expect(verifiedReview('1', careers, 'Senior AI Engineer at Acme').ok).toBe(false);
  });

  it('does not let a keyless read stand in for a job-board vacancy', () => {
    notePage('tab-1', careers, '1');
    noteReviewedPage('tab-1', careers, identity, '1');

    const verdict = verifiedReview('1', 'https://www.linkedin.com/jobs/view/4460977456/', 'Senior AI Engineer at Acme');
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toContain('different vacancy');
  });
});
