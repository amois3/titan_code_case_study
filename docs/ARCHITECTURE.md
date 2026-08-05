# Architecture

A single Node process: an agent loop, a terminal renderer written directly
against ANSI, a tool layer, and SQLite underneath. No framework, no UI
library. What follows is how the pieces fit and why they are shaped this way.

```
src/
  main.ts            wiring: argv, session, screen, agent, command dispatch
  app/               pure helpers extracted from main (confirm, help, paths)
  agent/             the loop — tool calls, compaction, subagent dispatch
  screen/            the terminal: renderer, layout, keyboard, seven zones
  tools/             13 tools, plus the shell, sandbox and policy layers
  commands/          35 slash commands
  storage/           sessions, tasks, queue, preferences, skill state
  secrets/           SecretStore (file default; keychain reserved)
  e2e/               packaging and runtime API smoke tests
  mcp.ts             MCP client
  mcpTransport.ts    stdio and Streamable HTTP
```


## The loop

`agent/index.ts` holds a conversation, sends it with a tool schema, and acts
on what comes back. Each turn the model either answers or asks for tools; tool
results are appended and the loop continues, up to a turn limit that can be
extended at most three times.

Three details are not obvious from that description.

**Confirmation suspends rather than aborts.** A tool needing approval does not
fail the turn. The pending call and the whole conversation are held, the user
answers, and execution resumes from exactly that point. A dialog that
discarded the agent's work would create pressure to approve quickly in order
not to lose it.

**Compaction is triggered by the model's own context length.** When history
approaches the limit, older turns are summarised into a single system message
and the tail is kept verbatim. The threshold comes from the model list rather
than a constant, because a 200k model and a 32k model should not compact at
the same point.

**Implicit tool calls are inferred.** Some models announce an action in prose
instead of emitting a call — "let me look at the project structure" with no
tool call attached. `agent/implicitToolCalls.ts` recognises the shape and
issues the call, rather than letting the turn end with a promise and no work.

## The terminal layer

`src/screen/` is 14 modules and no dependencies.

```
renderer.ts        ANSI primitives: alternate buffer, scroll regions, cursor
layout.ts          how the rows divide between the zones
state.ts           the single state object a repaint reads
keyboard.ts        key decoding, including escape sequences
highlightToAnsi.ts syntax highlighting to ANSI
zones/             statusBar, inputLine, messageArea, confirmBar,
                   slashMenu, picker, skillHint
```

A repaint writes only rows that changed. The alternate screen buffer keeps the
session out of the user's scrollback, and the scroll region confines message
output to its own area so the input line and status bar do not move.

Writing this by hand rather than taking Ink was a deliberate trade, and the
reasoning is in [DECISIONS.md](DECISIONS.md#adr-2--a-hand-written-renderer-instead-of-ink).

## Tools

Thirteen, registered in `tools/index.ts` with a Zod schema each, converted to
JSON Schema for the model.

```
read_file  write_file  edit_file  list_directory  glob_tool  grep_search
print_tree  run_bash  exec_shell_wait  exec_shell_interact  exec_shell_cancel
fetch  web_search
```

Shell work goes through three layers that exist independently of each other:

- `shellRuntime.ts` picks the shell and spawns it. A real POSIX shell is
  preferred everywhere, including Git Bash on Windows, so a command means the
  same thing on every platform. Termination signals the whole process group,
  because a timeout that kills only the shell leaves its children holding
  ports.
- `shellPolicy.ts` and `shellLexer.ts` read the command before it runs.
- `sandbox.ts` wraps it in kernel confinement.

All three are described in [SECURITY.md](SECURITY.md).

## Memory and context

What reaches the model each turn:

1. The system prompt: persona, operating rules, output style, language.
2. Project context — `AGENTS.md`, `TITAN.md`, `.agent/rules/*`, a workspace
   scan, package metadata. Cached for fifteen seconds so a burst of turns does
   not re-read the tree.
3. Memory layers, user-level and project-level.
4. Active skills, loaded on demand rather than always present.
5. The conversation, compacted if long.

Paths inside these sections render with forward slashes on every platform. The
same project describing itself differently per machine would produce different
bytes for identical content, which breaks prompt caching and makes project
instructions harder to match on.

## Storage

SQLite via better-sqlite3, in a namespace of its own so nothing collides with
another tool's state.

```
~/.local/state/titan-code/sessions.sqlite3   sessions, messages, usage, cost
~/.local/share/titan-code/prefs.json         last model, style, session
~/.config/titan-code/                        secrets, rules, MCP servers
```

The schema migrates forward on open — a column added later is created on the
existing table rather than requiring a fresh database. The store can be closed
explicitly, which matters on Windows, where an open handle blocks deleting or
renaming the file.

## MCP

`mcpTransport.ts` defines one interface with two implementations.

**stdio** launches a local server and speaks newline-delimited JSON — and also
accepts `Content-Length` framing, which servers built on Language Server
Protocol tooling use. Read line by line those produce nothing parseable, so
the connection merely appears dead.

**Streamable HTTP** posts JSON-RPC and handles a reply arriving as either a
JSON document or an event stream. The specification lets the server choose;
a client that handles one hangs against the other. The session id the server
assigns is carried on every later request, and a bearer token comes from the
config or from `TITAN_CODE_MCP_TOKEN_<NAME>`.

Tools, resources and prompts are all exposed. Names are prefixed with the
server they came from, so `github:search_issues` and `local:search_issues` do
not collide.

## Subagents, skills, hooks

**Subagents** are Markdown files with frontmatter — a name, a description, a
tool list — in `.titan-code/agents/` for the project or the config directory
for the user. Project definitions win on a name clash.

**Skills** are instruction fragments loaded only when relevant, so capability
can grow without every prompt growing with it.

**Hooks** are your own commands, bound to lifecycle events, receiving a JSON
payload on stdin. `PreToolUse` can refuse an action by answering
`{"continue": false}` or by exiting 2. They run unconfined, deliberately:
they are the operator's code, not the model's.

## Platform handling

The tool was written on Linux and assumed it. Porting it meant naming every
assumption one at a time:

| Assumption | Replacement |
|---|---|
| `spawn('bash')` | shell detection, POSIX preferred everywhere |
| `child.kill()` | process group on POSIX, `taskkill /T` on Windows |
| `LANG` / `LC_ALL` | `Intl` when the environment says nothing |
| `/tmp/x.sock` | named pipe on Windows |
| `/` in path comparisons | `path` API, normalised for display |
| database left open | explicit close, because Windows locks open files |

CI runs the whole gate on Linux, Windows and macOS across three Node versions,
so the next assumption is caught by a machine rather than by a person.
