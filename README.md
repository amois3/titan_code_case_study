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
npm install && npm test     # 255 tests, no API key, no network, no product
```

The badge above is this repository's own CI: nine jobs across Linux, macOS and
Windows on Node 20, 22 and 24.

---

## What is here

Twelve modules, 2,548 lines, **zero runtime dependencies** — node's standard
library and nothing else. 2,698 lines of tests across 13 files, and the three
design documents the product ships with — 627 lines, copied unchanged.

| Module | Lines | What it does |
|---|---:|---|
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

Across all four runs a fifth question that none of them asks: *is this
destroying something that exists nowhere else?* That one is
[`workspaceGuard.ts`](src/workspaceGuard.ts), below.

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

## The failure mode nobody counts: refusing ordinary work

A guard that blocks work people legitimately do gets switched off, and a
switched-off guard protects nothing. That failure never shows up in a security
review, because every individual refusal looks like the system working.

Three of them shipped, and all three came from the same place — reading a
command more literally than a shell does:

| Command | What the guard saw | What it is |
|---|---|---|
| `npm test 2>&1` | a redirect into a file called `1` | duplicating a file descriptor; it names no file |
| `echo x > out.txt` | a truncating write, refused outside a git repository | creating a file that does not exist yet |
| `node -e "setTimeout(() => {}, 30_000)"` | `=>` read as a redirect into a file called `{},` | JavaScript, which is not shell and cannot be lexed as it |

Each was refused with a message about destroying things, for a command that
destroyed nothing. The fixes are narrow and each has a regression test:
descriptor duplication is recognised in the lexer; a truncating write is
destruction only when the target exists (a pattern like `rm -rf *` still
counts, since it names no path that exists under that spelling); and only real
shells get their `-c` argument re-lexed as a command.

The last one had a second half. Not parsing `python -c "…"` as shell loses
whatever the old reading caught by luck, so what the interpreter is handed is
now scanned for the *name* of a command instead — which catches
`python -c "os.system('curl …')"`, something the shell re-parse never did.

## Why git decides what may be destroyed

`git reset --hard`, `git clean -fd` and `rm -rf src` are routine against a
clean tree and unrecoverable against a dirty one. The same command, the same
words, opposite consequences — so refusing them by name would make the agent
useless at exactly the moments it should be tidying up, and allowing them by
name loses an afternoon of uncommitted work.

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

## Testing what this machine cannot run

`sandbox.ts` and `shellRuntime.ts` decide what confines a command and what
interprets it, and both branch on the platform. Written on Windows, most of
each file was therefore never executed by anything, tests included — including
the half that defines the security boundary.

Two test files stand the platform and the binaries in for that: what is under
test is the decision, not the kernel underneath it. bubblewrap present and
working, present and unable to create a namespace, present and unrunnable,
absent; Seatbelt the same; the decision made once per process; the refusal to
confine a command to *nothing* when every writable root has been deleted
underneath it. And on the shell side: Git Bash preferred, a `bash.exe` left
behind by an uninstall that exists and will not start, the fall through to
PowerShell and then cmd, an override naming a program that is not there.

`sandbox.ts` went from 56% to 99% of statements this way, `shellRuntime.ts`
from 67% to 86% — numbers that matter only because of *which* lines they are.

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

Verified against the tree at the time of writing, not from memory:

| | |
|---|---|
| TypeScript | 22,729 lines across 159 modules |
| Tests | 2,083, in 158 files — 95.6% of statements, 89.0% of branches |
| CI | 9 matrix jobs on Linux, macOS and Windows × Node 20, 22, 24, plus coverage and a dependency audit |
| Slash commands | 36 |
| Agent tools | 13, six of them behind a confirmation |
| Terminal layer | 14 modules, written directly against ANSI — no Ink, no React, no curses |
| Runtime dependencies | 7 |

The renderer draws with an alternate screen buffer, scroll regions and cursor
control, and repaints only what changed. Sessions live in SQLite and survive a
restart; work can be delegated to subagents; MCP servers are reachable over
stdio and Streamable HTTP.

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

`SECURITY.md` has a section called *What this does not cover*. A security
document that lists only strengths is not describing a real system.

## Licence

MIT. See [LICENSE](LICENSE).
