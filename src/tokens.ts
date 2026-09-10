// tokens.ts - how many tokens a piece of text will cost, near enough to act on.
//
// Extracted from the agent's compaction path. Everything that decides when a
// conversation must be shortened rests on this number, and it is deliberately
// biased upward: an underestimate compacts too late, and too late is a request
// the provider refuses outright.

/**
 * Roughly how many tokens a string costs.
 *
 * Four characters per token is the usual rule of thumb and it is optimistic.
 * Measured against a session this CLI actually lost: the provider counted
 * 256,604 tokens of text where this counted 220,396 — sixteen per cent under,
 * on mostly-English code and paths.
 *
 * Non-Latin text is worse. A byte-pair vocabulary trained mostly on English
 * splits Cyrillic into far smaller pieces, so a Russian conversation can run
 * to roughly twice the naive estimate. Since this decides when to compact, an
 * underestimate means compacting too late, and too late means the provider
 * refuses the request — so the count leans the other way, in proportion to how
 * much of the text is not Latin.
 */
export function estimateTokens(text: string): number {
  const value = text || '';
  if (value.length === 0) return 0;

  // Long runs of the base64 alphabet are encoded payloads — a data URL, an
  // uploaded file, a token — not prose. A byte-pair vocabulary holds no words
  // for them, so they tokenize far below the prose rate: measured against the
  // request a provider refused, 2.4 MB of mostly-base64 tool text came back
  // over one million tokens, where the plain divisor below called it ~650k.
  // Pricing those runs at 2.5 characters per token leans high, which is the
  // side that compacts early instead of dying on a 400.
  //
  // The diversity test is what keeps prose-like repetition — a line of
  // dashes, a filler block, an ASCII border — out of the higher price: real
  // base64 of any length contains every character class, a repeated
  // character does not.
  const encodedRuns = (value.match(/[A-Za-z0-9+/=_-]{160,}/g) ?? [])
    .filter((run) => /[a-z]/.test(run) && /[A-Z]/.test(run) && /[0-9]/.test(run));
  const encodedChars = encodedRuns.reduce((total, run) => total + run.length, 0);

  const nonLatin = (value.match(/[^\p{ASCII}]/gu) ?? []).length;
  // Encoded runs are ASCII by construction, so they never touch the nonLatin
  // count; what remains after them is the prose the divisors were tuned on.
  const latin = value.length - nonLatin - encodedChars;
  // Calibrated against that lost session rather than guessed: these divisors
  // land about seven per cent above what the provider counted, which is the
  // margin wanted here and not so wide that compaction starts firing for no
  // reason.
  return Math.ceil((latin / 3.8) + (nonLatin * 0.9) + (encodedChars / 2.5));
}
