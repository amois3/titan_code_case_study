# Security

This agent edits files and runs shell commands on the machine it is installed
on, driven by a language model that reads content it did not write — source
files, web pages, whatever a repository happens to contain. The question is
not whether the model behaves well. It is what happens when it does not.

Four layers stand in front of a shell command. Each catches what the one
before it cannot, and the last one does not depend on understanding the
command at all.

---

## 1. Consent

Tools are classified by what they can do, not by how often they are used.

| Confirmed before running | Runs without asking |
|---|---|
| `run_bash` | `read_file` |
| `write_file` | `list_directory` |
| `edit_file` | `glob_tool` |
| `fetch` | `grep_search` |
| `web_search` | `print_tree` |
| `exec_shell_interact` | `exec_shell_wait` |
| | `exec_shell_cancel` |

The calibration was inverted at one point: an arbitrary shell command ran
silently while cancelling a background job asked permission. That is worse
than having no prompts at all, because the cheap prompts build the habit of
approving without reading — and the habit is then spent on the one prompt that
mattered. A test now fails if a newly registered tool is left unclassified,
since the default for an unclassified tool is silence.

Approving repeatedly is handled by *allow this tool for this session* (the
confirm bar's **S** option, which adds one tool to the session allowlist) and
by `/allow add all` for an explicit full bypass. Auto-accept mode auto-approves
`write_file` / `edit_file` only; shell and network still ask.

## 1c. Secrets storage

API keys from `/secrets` live in a `SecretStore`. There is one backend:
`~/.config/titan-code/secrets.json` with mode `600` where the OS honours it.
An OS keychain / DPAPI adapter can be added behind the same interface. Until
one exists there is no setting to choose between, because a setting whose two
values resolve to the same file store reads as encryption the product does not
provide.

## 1b. Outbound fetch

`fetch` refuses loopback, link-local, and RFC1918 targets by default (including
cloud metadata at `169.254.169.254`), after both a literal check and a DNS
lookup. Redirects are followed **manually** (not by the HTTP client) so every
`Location` hop is checked the same way — a public URL that 302s to
`127.0.0.1` is blocked. Override with `TITAN_CODE_ALLOW_PRIVATE_NETWORK=1`
when you deliberately need local services. Confirmation is still required for
every fetch.

## 2. Command analysis

`checkShellPolicy` reads the command before it runs, and *reads* is the
operative word: the command is lexed, not pattern-matched.

Splitting on `&& || ; |` and taking the first word — the previous approach —
missed ten spellings of the same call. All are now closed:

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

Substitutions and inline interpreter scripts are analysed recursively with
the same policy, since a substitution is an ordinary command that happens to
be written inside another.

**This layer is a filter and not a boundary.** A shell has more spellings than
anyone enumerates, and a path can be assembled at runtime from pieces no
static reading can follow. Which is the reason for the next layer.

## 3. Path containment

`isPathInsideRoot` resolves symlinks before comparing, walking the path one
component at a time.

Comparing resolved strings is not enough. A link placed inside the workspace
and pointing outside produces a path that reads as contained while the file it
designates is not — and the agent reads repositories it did not write, so such
a link is not hypothetical. Dangling links are followed too: writing through
one still lands wherever it points.

The workspace root itself is chosen carefully. Searching upward for project
markers used to reach the home directory, where an ordinary `AGENTS.md` or
`README.md` would make the entire user profile the workspace. The home
directory and the filesystem root are now never accepted as a project root,
from the marker search or from `git rev-parse`. When nothing is recognisable
the starting directory wins: narrow is the right way to be wrong.

## 4. The sandbox

Shell commands run inside kernel confinement.

| Platform | Mechanism | Status |
|---|---|---|
| Linux | bubblewrap | verified end to end, in CI on every push |
| macOS | Seatbelt via `sandbox-exec` | verified end to end, in CI on every push |
| Windows | — | none available |

Verified means a test writes a file inside the workspace, writes one outside
it, and asserts that the second did not happen. Where a sandbox is meant to
exist, its absence fails the suite rather than skipping it: a skipped security
test looks exactly like a passing one.

The workspace and the temporary directory are writable. Everything else is
read-only. Reads stay broad on purpose: toolchains live all over the
filesystem, and the containment that matters is on writes.

What this catches that layer 2 cannot:

```bash
p=$(printf '%s' "/etc/passwd"); printf '%s' x > "$p"
```

The destination is assembled at runtime inside the shell. No analysis of the
command text can see it. The kernel refuses the write anyway.

**Network is allowed by default.** Cutting it would break `npm install` and
`pip install` while closing nothing — the agent's own `fetch` and `web_search`
go through Node and never enter this sandbox. A sandbox that makes ordinary
work impossible gets switched off, and a switched-off sandbox protects
nothing. `TITAN_CODE_SANDBOX_NETWORK=off` disables it for anyone who wants
that trade.

**Hooks run unconfined**, deliberately: they are the operator's own commands,
not the model's, and are expected to reach outside the workspace.

---

## What this does not cover

A security section that lists only strengths is not describing a real system.

**Windows has no sandbox.** There is no equivalent of Landlock or Seatbelt
reachable from Node without a native addon. On Windows, layers 1 to 3 are all
there is. `/status` and `--help` say so in words.

**Linux can lose it too.** bubblewrap needs unprivileged user namespaces, and
containers and CI runners often disable them. Being installed is therefore not
enough, so the backend is asked to run a trivial command before it is trusted;
if that fails the CLI continues without confinement and states the reason
rather than failing every shell command. Trusting the binary's mere presence
did exactly that once — the fix is why the probe exists.

**An approved command is unbounded.** The gate guarantees a human sees the
exact command. It does not evaluate whether the command is wise. The quality
of the last line of defence is the quality of the person reading it.

**Reads are broad by design.** The sandbox restricts writes. A prompt injected
through a fetched page or a file in the repository could direct the agent to
read something sensitive and repeat it back. Nothing here prevents that.

**The denylist is a denylist.** `curl`, `wget`, `ssh` and the rest are refused
by name. Denylists are structurally incomplete: they catch the obvious cases
and would not catch a novel one. The sandbox is what makes that acceptable —
on the platforms that have one.

**Secrets are filtered, not isolated.** `buildShellEnv` passes an allowlist of
environment variables, so `OPENROUTER_API_KEY` does not reach a shell command.
A command that reads `~/.config` for itself is a different matter, and on
Linux and macOS the sandbox is what stops it writing there — not reading.

## Reporting

This is a personal tool with one operator. If you are reading it as a
reviewer and find something above that is wrong, the finding is welcome;
there is no bounty and no SLA.
