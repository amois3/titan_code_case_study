# Titan Code — the security core, extracted

[![CI](https://github.com/amois3/titan_code_case_study/actions/workflows/ci.yml/badge.svg)](https://github.com/amois3/titan_code_case_study/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-3c873a?logo=node.js&logoColor=white)](package.json)
[![TypeScript](https://img.shields.io/badge/typescript-strict-3178c6?logo=typescript&logoColor=white)](tsconfig.json)
[![Runtime deps](https://img.shields.io/badge/runtime%20dependencies-0-brightgreen)](package.json)
[![License](https://img.shields.io/badge/license-MIT-yellow)](LICENSE)

Titan Code is a terminal coding agent I wrote in TypeScript: its own tool loop,
its own ANSI renderer, MCP over stdio and Streamable HTTP, and OS-level
confinement for shell commands. The implementation is private. I walk through
the code in interviews.

This repository is not a description of it. It is the part that answers the
question the product exists to answer — *what stops a language model from
doing damage on my machine* — lifted out with its tests and its CI, so it can
be read, run and disagreed with.

```bash
npm install && npm test     # 62 tests, no API key, no network, no product
```

The badge above is this repository's own CI: nine jobs across Linux, macOS and
Windows on Node 20, 22 and 24.

---

## What is here

Eleven modules, 1,886 lines, **zero runtime dependencies** — node's standard
library and nothing else. 705 lines of tests, and the three design documents
the product ships with — 606 lines, copied unchanged.

| Module | Lines | What it does |
|---|---:|---|
| [`shellLexer.ts`](src/shellLexer.ts) | 227 | Lexes a shell command: quoting, escapes, substitutions, redirections, separators |
| [`shellPolicy.ts`](src/shellPolicy.ts) | 441 | The policy over that lexer — wrapper chains, inline interpreters, argument writers |
| [`pathPolicy.ts`](src/pathPolicy.ts) | 209 | Containment: resolves symlinks component by component, including links whose target does not exist yet |
| [`sandbox.ts`](src/sandbox.ts) | 289 | bubblewrap and Seatbelt backends, probed before they are trusted |
| [`shellRuntime.ts`](src/shellRuntime.ts) | 249 | Shell detection, spawning under confinement, killing a whole process tree |
| [`urlPolicy.ts`](src/urlPolicy.ts) | 174 | SSRF: literal and DNS checks, and every redirect hop checked again |
| [`repeatGuard.ts`](src/repeatGuard.ts) | 124 | Detects a model repeating a failing call and stops the loop |
| [`secrets/`](src/secrets) | 139 | Credential storage, and an honest statement of what it does not encrypt |
| [`paths.ts`](src/paths.ts) | 34 | The XDG locations the secret store writes to |

## The problem

An agent that can only suggest is safe and not very useful. An agent that can
edit files and run commands is useful and cannot be trusted by construction:
it is driven by a model that reads content nobody vetted — source files, web
pages, whatever a repository happens to contain.

So the question is never *will the model behave*. It is *what happens when it
does not*, and the answer has to hold without depending on the model's
cooperation.

Four layers, each catching what the one before it cannot:

1. **Consent** — irreversible tools are confirmed by a human, cheap ones are not.
2. **Command analysis** — the command is lexed and inspected before it runs.
3. **Path containment** — every path is resolved through symlinks before comparison.
4. **The kernel** — the write is refused regardless of how it was spelled.

Layer 4 exists because layer 2 cannot be finished. That is the whole argument,
and [docs/SECURITY.md](docs/SECURITY.md) names what each layer still leaves open.

## Why the lexer

The first version split on `&& || ; |` and took the first word. It missed ten
spellings of the same call — found by writing them down and running them, not
by reading the code:

| Spelling | Why it got through |
|---|---|
| `echo $(curl …)` | substitutions were never looked inside |
| `` echo `curl …` `` | same, with backticks |
| `/usr/bin/curl …` | the denylist held bare names |
| `env curl …` | the wrapper's name was reported instead |
| `echo url \| xargs curl` | same |
| `bash -c "curl …"` | the interpreter's name was reported |
| `sleep 1 & curl …` | a single `&` was not a separator |
| `echo x > /etc/thing` | redirections were not examined |
| `echo x \| tee /etc/thing` | writes through arguments, not `>` |
| `dd of=/etc/thing` | destination hidden in an assignment |

All ten are closed, and all ten are in [`shellPolicy.test.ts`](src/shellPolicy.test.ts).
Substitutions and inline interpreter scripts are analysed recursively, because
a substitution is an ordinary command that happens to be written inside
another one.

The fix also introduced a bug worth keeping in the record. Treating `\` as an
escape inside double quotes is correct for POSIX and wrong for the thing the
agent is actually handed: `cd "C:\Users\dev"` became `cd "C:Usersdev"`, which
resolved *inside* the workspace and was allowed to run. One constant now says
exactly which characters a backslash escapes, and the reason is written above
it in [`shellLexer.ts`](src/shellLexer.ts).

## Why the kernel

Reading a command string can narrow risk. It cannot bound it:

```bash
p=$(printf '%s' "/etc/passwd"); printf '%s' x > "$p"
```

The destination is assembled at runtime, inside the shell. No analysis of the
command text can see it. The kernel refuses the write anyway — and
[`sandbox.test.ts`](src/sandbox.test.ts) proves it by writing a file inside the
workspace, writing one outside it, and asserting the second did not happen.

**Presence is not capability.** bubblewrap needs unprivileged user namespaces,
which containers and CI runners routinely disable. Selecting it because the
binary exists made every shell command fail on GitHub's Ubuntu runners. The
backend is now asked to run `exit 0` before it is trusted, and falls back to no
confinement with the reason stated rather than breaking the tool.

**A skipped security test reads as a passing one.** With
`TITAN_CODE_REQUIRE_SANDBOX=1` — which the Linux and macOS jobs set — the
absence of a backend fails the suite instead of quietly stepping aside.

## Why containment is not string comparison

A symlink placed inside the workspace and pointing outside produces a path that
reads as contained while the file it designates is not. The agent reads
repositories it did not write, so that is not hypothetical.

`realpathSync` cannot be used on its own: it throws for a path that is not
fully present — the normal case when a file is about to be created — and for a
dangling link, even though writing through that link still lands wherever it
points. So the path is walked one component at a time, and each existing
component is dereferenced.

The macOS case is the one that cost three red CI jobs: `/var` is a link to
`/private/var`, so following an absolute symlink target without re-resolving
*its* ancestors left the workspace root and a file inside it with different
prefixes, and a file plainly inside the workspace was refused as foreign.
[`pathPolicy.test.ts`](src/pathPolicy.test.ts) builds that shape on any
platform.

## Running it

```bash
npm install
npm test          # 62 tests in 7 files
npm run verify    # typecheck, lint, test
```

Node 20 or newer. Nothing here needs an API key or a network.

On Linux, `apt install bubblewrap` makes the containment tests run instead of
skip; on macOS `sandbox-exec` is already there. Windows has no filesystem
sandbox reachable from Node without a native addon. The containment tests skip
there, and the product states the absence at runtime rather than implying a
protection it does not have.

## The product this comes from

Verified against the tree at the time of writing, not from memory:

| | |
|---|---|
| TypeScript | 15,560 lines across 126 modules |
| Tests | 220, in 55 files |
| CI | 9 matrix jobs on Linux, macOS and Windows × Node 20, 22, 24, plus coverage and a dependency audit |
| Slash commands | 35 |
| Agent tools | 13, six of them behind a confirmation |
| Terminal layer | 14 modules, written directly against ANSI — no Ink, no React, no curses |
| Runtime dependencies | 7 |

The renderer draws with an alternate screen buffer, scroll regions and cursor
control, and repaints only what changed. Sessions live in SQLite and survive a
restart; work can be delegated to subagents; MCP servers are reachable over
stdio and Streamable HTTP.

## Documents

These ship with the product and are copied here unchanged.

| | |
|---|---|
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | the loop, the terminal layer, memory, MCP |
| [SECURITY.md](docs/SECURITY.md) | the four layers, and what each one leaves open |
| [DECISIONS.md](docs/DECISIONS.md) | why the design is what it is, and what each choice cost |

`SECURITY.md` has a section called *What this does not cover*. A security
document that lists only strengths is not describing a real system.

## Licence

MIT. See [LICENSE](LICENSE).
