# Decisions

What was chosen, what it cost, and how to undo it. Several entries reverse an
earlier decision of mine; those are the useful ones.

---

## ADR-1 — TypeScript, after a Go wrapper and a Python rewrite

**Decision.** This CLI is TypeScript, written from scratch.

**What came before.** The first version wrapped an existing Go tool. It worked
and taught me what I actually wanted, which the wrapper could not give: control
of the rendering and of the agent loop. The second was a full Python rewrite
on Textual, taken to a usable state before I concluded the framework was the
ceiling — rendering slowed noticeably past a hundred messages, custom
interaction inside the message stream was impractical, and a great deal of
time went into fighting the framework's focus and key-binding model rather
than building anything.

**Why this stack.** Drawing directly to the TTY removes the ceiling: only what
changed is repainted, and interaction can go anywhere on screen. It is also
the stack the tools I measure against are built on, which makes their
behaviour a reference I can actually compare with.

**Cost.** Two rewrites. The Python version was more feature-complete than this
one for several weeks.

---

## ADR-2 — A hand-written renderer instead of Ink

**Decision.** `src/screen/` writes ANSI escape sequences directly. No Ink, no
React, no curses.

**Why.** A React reconciler for a terminal buys component structure and pays
for it with a full-tree diff per frame and a dependency that owns the paint
loop. What this interface needs is narrower: repaint the rows that changed,
keep a scroll region so the input line stays still, put the session in the
alternate buffer so it does not pollute scrollback. That was about 800 lines
written once against a stable, forty-year-old interface; it is 1,755 across 14
modules now, and still owns its own paint loop.

**Cost.** Layout is manual. There is no component model, so a new zone means
new code in `layout.ts` rather than a new element in a tree.

**Note.** The README claimed "UI: Ink (React for terminal)" for months while
no such dependency existed. That was not modesty — it credited a library with
the most substantial part of the work.

---

## ADR-3 — Confirmation calibrated to effect, not to frequency

**Decision.** `run_bash`, `write_file` and `edit_file` ask. Reading tools and
job control do not.

**What was wrong.** `run_bash` executed arbitrary commands with no
confirmation while `exec_shell_cancel` — which only stops something already
running — asked for permission. Prompts on harmless actions are not free: they
build the habit of approving without reading, and the habit is spent on the
prompt that mattered.

**Guard.** A test fails when a newly registered tool is left unclassified,
because the default for an unclassified tool is silence.

---

## ADR-4 — Lex the command instead of pattern-matching it

**Decision.** `shellLexer.ts` parses quoting, operators, substitutions and
redirections; the policy runs over the parse.

**Why.** Splitting on `&& || ; |` and reading the first word missed ten
spellings of the same call — `$(…)`, backticks, `/usr/bin/curl`, `env`,
`xargs`, `bash -c`, a single `&`, `>`, `tee`, `dd of=`. Each could have been
patched individually; the tenth would have been followed by an eleventh.

**Limit, stated plainly.** This narrows risk and cannot bound it. A path
assembled at runtime inside the shell is invisible to any reading of the
command text. That limit is the entire argument for ADR-5.

---

## ADR-5 — Confine at the kernel

**Decision.** Shell commands run inside bubblewrap on Linux and Seatbelt on
macOS. Windows gets none, and says so.

**Why.** The operating system does not care how a write was spelled. Verified
end to end: a destination assembled at runtime — which no static analysis
could see — is refused anyway.

**Network stays on.** Cutting it would break `npm install` and `pip install`
while closing nothing, since `fetch` and `web_search` go through Node and
never enter this sandbox. A sandbox that makes ordinary work impossible gets
switched off, and a switched-off sandbox protects nothing.

**Reads stay broad.** Toolchains live all over the filesystem. Restricting
reads would break builds in exchange for protection that `read_file` already
bypasses.

**Windows.** No equivalent is reachable from Node without a native addon.
Claiming confinement there would be worse than admitting its absence, because
an operator who believes they are protected behaves differently.

**Presence is not capability.** bubblewrap needs unprivileged user namespaces,
which containers and CI runners routinely disable, so the binary can be
installed and still unable to start. Selecting it on presence alone made every
shell command fail on GitHub's Ubuntu runners. The backend is now asked to run
a trivial command before it is trusted, and falls back to no confinement with
the reason stated — the same principle as the Windows case, applied to a host
that only looks capable.

---

## ADR-6 — The home directory is never a project root

**Decision.** Neither the marker search nor `git rev-parse` may resolve the
workspace to the home directory or a filesystem root.

**What went wrong.** Searching upward for `package.json`, `README.md`,
`AGENTS.md` and the rest walked eight levels. Started anywhere without
markers — a temporary directory, for instance — it reached the home directory,
where an ordinary `AGENTS.md` made the entire user profile the workspace: every
key, every document, every other repository, all writable.

**Consequence.** When nothing is recognisable, the starting directory wins.
Narrow is the right way to be wrong.

---

## ADR-7 — Prefer a POSIX shell on every platform

**Decision.** A real POSIX shell is used wherever one exists, including Git
Bash on Windows. PowerShell and cmd are fallbacks.

**Why not cmd on Windows.** The model is prompted in POSIX terms and writes
`ls -la`, `grep -rn`, `a && b`. Handing that to cmd changes what the command
means. A tool that silently means something else is worse than one that
plainly does not run.

**Also.** Termination signals the whole process group, or walks the tree with
`taskkill` on Windows. A timeout that kills only the shell leaves `npm test`
children holding ports and writing files long after the tool reported failure.

---

## ADR-8 — One version, read from `package.json`

**Decision.** `src/version.ts` is the only place that knows the version.

**What was wrong.** It was written in three places and disagreed with itself:
`package.json` said 1.0.0, the welcome banner said v3.0.0, the MCP client
announced 3.0.0. A version that cannot be trusted is worse than none, because
bug reports quote it.

**Guard.** A test fails if the number appears a second time in the shipped
sources.

---

## ADR-9 — MCP as an interface with two transports

**Decision.** `mcpTransport.ts` defines a transport; stdio and Streamable HTTP
implement it.

**Why.** stdio alone limited the client to servers that can be launched as a
local subprocess, while most of the ecosystem is now hosted. Both response
shapes are handled — the specification lets a server answer with JSON or with
an event stream, and a client that handles one hangs against the other.

**Deliberately absent.** The interactive OAuth flow with dynamic client
registration. Bearer tokens are supported and a 401 explains itself. Shipping
an untested authorisation flow would be worse than shipping none.

---

## ADR-10 — Five dependencies removed rather than updated

**Decision.** `node-notifier`, `chalk`, `ora`, `marked` and `marked-terminal`
are gone.

**Why.** None were imported anywhere. The ANSI layer and the markdown
rendering are both written by hand; the packages were left over from earlier
versions. Both remaining audit findings lived in `node-notifier`, so removing
dead weight took the vulnerability count from four to zero without a single
version bump.

**Consequence.** Seven runtime dependencies remain, each one used.

---

## ADR-11 — CI on three platforms from the start

**Decision.** Every push runs typecheck, lint, tests and build on Linux,
Windows and macOS across Node 20, 22 and 24.

**Why.** This project became Linux-only without anyone intending it. Fifteen
tests failed on Windows, the shell tools did not run at all, and nothing said
so until a person tried it. `fail-fast` is off so one red platform does not
hide the state of another, and bubblewrap is installed on the Linux runner
because a skipped sandbox test reads exactly like a passing one.

That last point is enforced rather than hoped for: `TITAN_CODE_REQUIRE_SANDBOX=1`
in the Linux and macOS jobs turns a missing backend into a failure, and the
workflow lifts the AppArmor restriction on unprivileged namespaces so the
containment test actually runs there instead of stepping aside.

**It paid for itself immediately.** The first matrix run was six red jobs out
of ten, and none of them were CI quirks: the sandbox selected a bubblewrap
that could not start, and an absolute symlink target was followed without
re-resolving its own ancestors — which on macOS, where `/var` is a link to
`/private/var`, refused a file plainly inside the workspace. Both are defects a
user would have hit and neither is visible on the machine they were written on.

---

## ADR-12 — Lint for behaviour, not for style

**Decision.** Rules cover floating values, silent catches, `==`, unused code.
Formatting is left to `.editorconfig` and to review.

**Why.** A linter that argues about quotes teaches people to run `--fix`
without reading the output, and the one finding that mattered scrolls past
with the rest. The first run on these rules found a dead `require`, a bound
handler nothing called, a 39-line unreferenced function, three empty catches,
`const` declarations leaking across switch cases, and a thrown timeout that
discarded the error explaining why.

---

## ADR-13 — The May audit, and why its text is not in the tree

**Decision.** A full audit of the repository was written on 2026-05-07 and
lived in `docs/encyclopedic-audit/` until commit `790a63e`. Its findings are
recorded in the ADRs above; the text itself is not carried forward.

**Why.** It described a tree that no longer exists — `dist_or/`, `dist_se/`
and `dist_si/` alongside `dist/`, a README claiming an Ink UI that was never a
dependency, 69 source files and 5 tests. Every one of those is fixed, and the
document said so itself in a banner: *do not use it for current decisions*.
Documentation that has to warn the reader not to believe it is not
documentation. It was also written in Russian, while everything in this
project except the interface is English.

**Consequence.** The audit is reachable at
`git show 790a63e:docs/encyclopedic-audit/README.md` and in the five reports
beside it. What it produced — the path repair, the permission work, the SSRF
checks, the end-to-end tests — is in the code, and the ADRs say why.
