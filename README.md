# Titan Code — engineering case study and security core

[![CI](https://github.com/amois3/titan_code_case_study/actions/workflows/ci.yml/badge.svg)](https://github.com/amois3/titan_code_case_study/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-3c873a?logo=node.js&logoColor=white)](package.json)
[![TypeScript](https://img.shields.io/badge/typescript-strict-3178c6?logo=typescript&logoColor=white)](tsconfig.json)
[![Runtime deps](https://img.shields.io/badge/runtime%20dependencies-0-brightgreen)](package.json)
[![Titan Code](https://img.shields.io/badge/Titan%20Code-v3.4.2-6f42c1)](#the-product-this-comes-from)
[![License](https://img.shields.io/badge/license-MIT-yellow)](LICENSE)

Titan Code is a terminal coding agent I wrote in TypeScript: its own agent loop,
ANSI renderer, MCP client, multimodal computer vision and OS-level confinement
for shell commands. The same agent can read a codebase, understand screenshots,
operate a browser or Windows desktop, call tools and verify the result. The full
implementation is private; I walk through it in interviews.

This public repository documents how those capabilities fit together and
includes the extracted security core with its tests and CI. It can be read and
run without an API key or access to the private product.

```bash
npm ci && npm test          # 367 tests, no API key, no network, no product
```

The badge above is this repository's own CI: one representative job on each of
Linux, macOS and Windows, covering Node 20, 22 and 24 without spending nine
times the Actions allowance for the same platform signal.

## Where the extraction sits now

Titan Code has grown well beyond the snapshot this repository isolates. The
current product is v3.4.2: 234 TypeScript modules, 4,600+ tests across 265
files, 41 slash commands and 46 built-in tools. It drives a browser and, on
Windows, the desktop as well as a codebase. Native multimodal messages let it
reason over image attachments and live screenshots, while provider adapters
share one streaming and tool-call contract and autonomous runs retain a
durable record of what was actually completed.

This repository stays deliberately narrow. It remains the zero-runtime-
dependency security argument that can be read and executed without an API key
or access to the private product. The numbers below describe this repository;
the product snapshot near the end is dated and labelled separately.

## Semantic page understanding and computer vision

Titan Code has two complementary ways to understand an interface. Inside a web
page, `page_read` uses the Chrome extension and DevTools Protocol to turn the
live DOM into a compact, action-oriented semantic snapshot: page text, the main
heading, the active dialog, reachable frames and usable controls, each with a
role, accessible name, state, surrounding context and generation-safe `[ref]`
handle. It walks open shadow roots, merges nested frames and can read one page
branch in full. The model acts on those handles without needing the tab visible.

Two problems sit under that snapshot, and both are in this repository now.

A control the DOM cannot name is a control the model cannot choose:
application forms are largely unlabelled `div`s, and a snapshot of one reads as
a list of identical `generic ""` rows. `accessibilityEnrichment.ts` asks
Chrome's accessibility view for a computed name — for those controls only, at
most a handful per snapshot, never for a password field, and never for a handle
it did not issue. A page whose markup is honest asks nothing and pays nothing.

Knowing when a page has finished is the other. Sleeping a fixed interval after
a click is wrong in both directions: too long for a page that settled in 60 ms,
too short for a dialog that animates out over most of a second.
`pageSettled.ts` installs a MutationObserver for the length of one wait and
returns on a short quiet window, bounded so a page that never goes quiet costs
no more than the guess it replaces.

For visual state, native applications and browser surfaces outside the page,
screenshots and image attachments travel as native multimodal content. The
model can see the active application, choose an action and visually verify the
next frame; coordinate mapping and a bounded screenshot window keep that loop
accurate and efficient.

## What the full product delivers

The implementation stays private; these are the product capabilities and the
engineering choices that make them dependable.

**Every run stays observable.** The terminal distinguishes model thinking, tool
execution, waiting, retries and provider responses. Live progress, elapsed
time, steps and tool outcomes make long autonomous work understandable while
it is happening, and every stop has a concrete explanation.

**The terminal owns its geometry.** Model output, tool progress, navigation,
the input editor, confirmation UI and the status line have separate rows and
separate state. Repainting one cannot splice the chat input into a response.
Transcript navigation, mouse selection, wheel scrolling, input history and
vertical confirmation choices are first-class, tested product behaviour.

**A provider is an adapter, not another agent loop.** OpenAI Responses, OpenAI
Chat Completions, Anthropic Messages and Gemini-style streams are normalised
into one internal sequence of text, thinking, tool calls, usage and errors.
Model catalogues, prompt-cache metadata, prices and quota state sit outside the
loop, so adding a provider does not fork confirmation, persistence or retry
semantics.

**Autonomy remains controlled.** Repeat guards, scoped confirmations, durable
journals and resumable sessions let the agent work for a long time while
keeping actions reviewable and preventing unproductive loops.

---

## What a long conversation costs, and why the cheapest fix was free

Every turn re-sends the whole conversation. Providers price a cached prompt at a
fiftieth of a fresh one and key the cache on the prefix: byte-identical from the
start, or nothing.

An unattended run of 308 turns spent 36.1 million input tokens. Under the
working ceiling the cache carried 97.7% of each prompt and 1,852 tokens were
fresh — the new tool result and nothing else. From the turn the ceiling was
crossed, 33,398 were fresh, and stayed that way for two hundred and fifty turns.
Ninety-four per cent of that run's input bill was the fifth of the tokens the
cache had lost.

The cause was the shortening meant to keep the conversation small. The window of
tool results kept whole slid by one every turn, so one more message was
rewritten every turn and the prefix never held still. `contextBudget.ts` now
shortens up to a frontier that advances only under pressure and never retreats:
between advances the prefix only grows at the end. It keeps *more* history whole
than the sliding window did — a payload ages out at the next advance rather than
the next turn — so nothing was traded away for the saving. What was removed was
repeated work, not context.

This is also why the token estimator leans high. Non-Latin text splits into far
smaller pieces than English, and an underestimate compacts too late; too late is
a request the provider refuses outright, mid-task.

## An application recorded is an application that happened

An agent that applies to jobs unattended is trusted with a claim nobody watches
it make. `evidence.ts` is the part that refuses to take the run's word for it.

A record of a sent application is accepted only when a tool watched that tab
change into the site's own confirmation, for that vacancy, and when a full read
of that vacancy — not a search-results card — is what the subject was taken
from. The difference between "the page changed into this" and "the page was
showing this" is carried into the record, because a job board shows "applied"
on a vacancy someone applied to months ago.

Both halves have been wrong in production and are pinned here. Seven
applications were once recorded in an hour and one was found in the account,
every record written in good faith by a run whose own tools had told it the
page said "sent". Later the two rules deadlocked: proof of a submission was
discarded by navigating back to the vacancy the other rule demanded be read,
and the run's only way to record anything at all was to write "failed" on an
application the site was showing as sent.

## Signing in to a server that will not take a pasted token

A hosted MCP server can ask for more than a token copied from a settings page.
Upwork's does: OAuth 2.1, dynamic client registration, PKCE, a redirect that
has to land somewhere. `mcpOAuth.ts` and `mcpLogin.ts` are that flow, and they
depend on nothing but node.

Nothing in it is guessed. A 401 carries a header naming where the server's
rules live (RFC 9728); that document names an authorization server; that
server's own metadata names the endpoints. Each hop is asked for, because the
shape of these URLs differs between providers and reading one from another is
how a working server comes to look like a broken one. That is not a
hypothetical: this flow was nearly not built at all, on the strength of a URL
that looked like it could not support registration. Sending the request
returned `201 Created` with a client id.

The redirect lands on a listener bound to loopback, open for as long as the
approval takes and no longer. It accepts exactly one redirect — the one
carrying this attempt's own state — and answers anything else with a 404,
because a port on loopback is reachable by everything else on the machine. The
authorization code is bound to a PKCE verifier that never leaves the process
that generated it.

The first thing `/mcp login` tries is not a browser. Upwork's tokens last a
day, and a refresh token is worth trying before an interruption: an unattended
run that stops each morning to ask for a sign-in has stopped being unattended.
A refresh the server no longer honours is not an error either — it means
signing in properly, which is what happens next.

## What is here

Twenty-one modules, 4,610 lines, **zero runtime dependencies** — node's
standard library and nothing else. 4,376 lines of tests across 19 files, and a
678-line snapshot of the three design documents that shipped with the
extraction.

| Module | Lines | What it does |
|---|---:|---|
| [`contextBudget.ts`](src/contextBudget.ts) | 320 | What a long conversation is allowed to cost: shortening that a provider's cache can follow, and pruning before the request is refused |
| [`messageContent.ts`](src/messageContent.ts) | 157 | The shape a message takes when it carries text, images and file attachments at once |
| [`tokens.ts`](src/tokens.ts) | 53 | What a piece of text will cost, biased upward on purpose |
| [`evidence.ts`](src/evidence.ts) | 409 | What the page was watched doing, so a record of an application is a record of something that happened |
| [`accessibilityEnrichment.ts`](src/accessibilityEnrichment.ts) | 277 | Asks Chrome about the controls the DOM failed to name, and only those |
| [`pageSettled.ts`](src/pageSettled.ts) | 126 | Waits for the page to stop changing instead of sleeping a guessed interval |
| [`pageTypes.ts`](src/pageTypes.ts) | 57 | The browser-layer shapes the three modules above are written against |
| [`mcpOAuth.ts`](src/mcpOAuth.ts) | 342 | Discovery, dynamic registration, PKCE and token exchange — every hop asked for rather than assumed |
| [`mcpLogin.ts`](src/mcpLogin.ts) | 328 | The half that needs a browser: one redirect, on loopback, carrying this attempt's own state — and knowing when not to open one |
| [`shellLexer.ts`](src/shellLexer.ts) | 244 | Lexes a shell command: quoting, escapes, substitutions, redirections, descriptor duplication, separators |
| [`shellPolicy.ts`](src/shellPolicy.ts) | 546 | The policy over that lexer — wrapper chains, inline interpreters, argument writers |
| [`workspaceGuard.ts`](src/workspaceGuard.ts) | 330 | Asks git what a command would destroy, and refuses only when the answer is work that exists nowhere else |
| [`sandbox.ts`](src/sandbox.ts) | 325 | bubblewrap and Seatbelt backends, probed before they are trusted |
| [`shellRuntime.ts`](src/shellRuntime.ts) | 302 | Shell detection, spawning under confinement, killing a whole process tree |
| [`repeatGuard.ts`](src/repeatGuard.ts) | 236 | Detects a model repeating a failing call and stops the loop |
| [`pathPolicy.ts`](src/pathPolicy.ts) | 209 | Containment: resolves symlinks component by component, including links whose target does not exist yet |
| [`urlPolicy.ts`](src/urlPolicy.ts) | 189 | SSRF: literal and DNS checks, and every redirect hop checked again |
| [`secrets/`](src/secrets) | 133 | Credential storage, and an honest statement of what it does not encrypt |
| [`paths.ts`](src/paths.ts) | 34 | The XDG locations the secret store writes to |

## The operating model

Titan Code combines broad capability with boundaries enforced outside the
model. The model can edit files, run commands and operate applications, while
the runtime decides where it may write, which actions need consent and what
must remain recoverable.

Four layers, each catching what the one before it cannot:

1. **Consent** — irreversible tools are confirmed by a human, cheap ones are not.
2. **Command analysis** — the command is lexed and inspected before it runs.
3. **Path containment** — every path is resolved through symlinks before comparison.
4. **The kernel** — the write is refused regardless of how it was spelled.

Layer 4 exists because layer 2 cannot be finished. That is the whole argument,
and [docs/SECURITY.md](docs/SECURITY.md) names what each layer still leaves open.

Across all four runs a fifth question that none of them asks: *is this
destroying something that exists nowhere else?* That one is
[`workspaceGuard.ts`](src/workspaceGuard.ts), below.

## How command analysis works

The lexer turns shell text into structured syntax before policy is applied.
Wrappers, substitutions, interpreters, redirects and argument-based writers are
recognised as operations rather than judged by their first word:

| Form | What Titan understands |
|---|---|
| `echo $(curl …)` | a nested command substitution |
| `/usr/bin/curl …` | the executable name after path normalisation |
| `env curl …` | a wrapper followed by the command it launches |
| `bash -c "curl …"` | a shell script that needs recursive analysis |
| `echo x > /etc/thing` | a filesystem write through redirection |
| `dd of=/etc/thing` | a destination supplied as an argument assignment |

Each form is covered by regression tests in
[`shellPolicy.test.ts`](src/shellPolicy.test.ts). Substitutions and shell
scripts are analysed recursively, while other interpreter payloads use
language-appropriate signals instead of being mistaken for shell syntax.

## Security that remains useful

The policy distinguishes actual destructive behaviour from ordinary
development work. File-descriptor duplication, creation of a new file and an
inline JavaScript or Python program are classified according to what they do,
so common commands keep moving without weakening containment. Confirmations
are reserved for actions whose effect or recoverability genuinely warrants
human review.

## Recoverability-aware destructive operations

Destructive commands are evaluated in context rather than denied by name. A
clean, recoverable tree can be maintained automatically, while uncommitted or
untracked work receives stronger protection.

[`workspaceGuard.ts`](src/workspaceGuard.ts) asks git instead. It classifies
what a command would take — modifications to tracked files, untracked files, a
path outright — scopes that to the paths the command actually names, and
refuses only if something at risk has no copy anywhere. Outside a repository
there is no undo at all, so a recursive delete is refused there and a write is
not.

[`workspaceGuard.test.ts`](src/workspaceGuard.test.ts) runs against real
repositories built per test, because the question the guard asks — *what would
actually be lost* — is answered by git, and a mocked answer would be a test of
the mock.

## Kernel-enforced containment

Command analysis provides an early policy layer; the operating system provides
the final write boundary. bubblewrap on Linux and Seatbelt on macOS confine the
process even when a destination is assembled dynamically at runtime.
[`sandbox.test.ts`](src/sandbox.test.ts) verifies allowed workspace writes and
blocked external writes against the real backend.

Backends are capability-probed before use, not selected merely because a binary
exists. CI makes the security backend mandatory on supported runners, so the
containment guarantee is exercised on every push.

## Cross-platform verification

`sandbox.ts` and `shellRuntime.ts` separate platform decisions from process
execution. Their tests cover bubblewrap, Seatbelt, Git Bash, PowerShell and cmd
through injected capabilities, while the CI matrix runs the complete project on
Linux, macOS and Windows.

`sandbox.ts` went from 56% to 99% of statements this way, `shellRuntime.ts`
from 67% to 86% — numbers that matter only because of *which* lines they are.

## Symlink-aware path containment

Containment follows every existing path component through symlinks before a
write is classified, so the effective destination — not its spelling — defines
the security boundary.

`realpathSync` cannot be used on its own: it throws for a path that is not
fully present — the normal case when a file is about to be created — and for a
dangling link, even though writing through that link still lands wherever it
points. So the path is walked one component at a time, and each existing
component is dereferenced.

The same canonicalisation also handles macOS aliases such as `/var` and
`/private/var`. [`pathPolicy.test.ts`](src/pathPolicy.test.ts) builds these
filesystem shapes on every platform.

## Running it

```bash
npm install
npm test          # 255 tests in 13 files
npm run verify    # typecheck, lint, test
```

Node 20 or newer. Nothing here needs an API key or a network.

On Linux, `apt install bubblewrap` makes the containment tests run instead of
skip; on macOS `sandbox-exec` is already there. Windows has no filesystem
sandbox reachable from Node without a native addon. The containment tests skip
there, and the product states the absence at runtime rather than implying a
protection it does not have.

## The product this comes from

Verified against Titan Code v3.4.2 on 10 September 2026, not reconstructed
from memory:

| | |
|---|---|
| Version | 3.4.2 |
| TypeScript | 48,680 lines across 232 production modules |
| Tests | 4,600+ in 263 files, with enforced coverage thresholds |
| CI | Linux, macOS and Windows on Node 20, 22 and 24, plus coverage, build smoke tests and a production dependency audit |
| Slash commands | 41 |
| Agent tools | 46, 20 of them behind a confirmation |
| Computer vision | native multimodal screenshots and image attachments, vision routing, bounded visual context and coordinate mapping |
| Browser and desktop | semantic Chrome extension transport plus visually guided OS-level computer use on Windows |
| Terminal layer | 13 modules, written directly against ANSI — no Ink, no React, no curses |
| Runtime dependencies | 7 |

The renderer draws with an alternate screen buffer, cursor control and
row-level repainting while keeping transcript history navigable. Sessions live
in SQLite and survive a restart; work can be delegated to subagents; MCP
servers are reachable over stdio and Streamable HTTP.

The coverage gate is set just under what the suite achieves, so it catches a
slide rather than blocking the next commit. Two things it deliberately does
not measure: the terminal layer, which needs a TTY that does not exist in a
test run, and the composition root, which wires the pieces and does nothing
else. Everything either of those would have hidden was moved out into modules
that are measured.

## Documents

These ship with the product and are copied here unchanged.

| | |
|---|---|
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | the loop, the terminal layer, memory, MCP |
| [SECURITY.md](docs/SECURITY.md) | the four layers, and what each one leaves open |
| [DECISIONS.md](docs/DECISIONS.md) | why the design is what it is, and what each choice cost |

`SECURITY.md` makes the trust boundary explicit, so the guarantees described
here remain concrete and testable.

## Licence

MIT. See [LICENSE](LICENSE).
