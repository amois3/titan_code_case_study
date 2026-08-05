# About these documents

These three ship with Titan Code and are copied here **unchanged**. They
describe the whole product, not the subset extracted into this repository, so
they refer to modules that are not here — `src/screen/`, `src/version.ts`, the
agent loop, the MCP transports.

That is deliberate. Editing them to match a smaller repository would produce
documents that were written for this repository, which is a different and less
useful thing to read: what is worth seeing is what the project actually
documents for itself.

| | |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | the loop, the terminal layer, memory, MCP |
| [SECURITY.md](SECURITY.md) | the four layers in front of a shell command, and what they leave open |
| [DECISIONS.md](DECISIONS.md) | why the design is what it is, and what each choice cost |

The modules in [`../src`](../src) are the ones `SECURITY.md` is about, so that
is the document to read alongside the code.
