/**
 * A small shell lexer, used to decide policy on a command before it runs.
 *
 * The previous approach split the command string on `&& || ; |` and took the
 * first word of each piece. Everything that hides the command name from that
 * reading slipped through: `$(curl …)`, backticks, an absolute path to the
 * binary, wrappers like `env` and `xargs`, a nested `bash -c "…"`, a single
 * `&`, and any redirection into a file outside the workspace.
 *
 * Reading the command properly is the only way to close that class of gap.
 * The lexer is deliberately narrow: it recognises quoting, operators,
 * substitutions and redirections — enough to know *what will run and where it
 * will write* — and nothing else. It is not a shell and never executes
 * anything.
 */

export interface Redirection {
  /** Operator as written: `>`, `>>`, `2>`, `&>`, `<`. */
  operator: string;
  /** Target as written, quotes removed. */
  target: string;
}

export interface ShellSegment {
  /** The segment source, for messages. */
  text: string;
  /** Words with quoting resolved, in order. */
  words: string[];
  /** Files this segment reads from or writes to. */
  redirections: Redirection[];
}

export interface ParsedCommand {
  segments: ShellSegment[];
  /** Command strings found inside `$( … )` or backticks, at any depth. */
  substitutions: string[];
}

/** The only characters a backslash escapes inside double quotes. */
const DOUBLE_QUOTE_ESCAPABLE = new Set(['$', '`', '"', '\\', '\n']);

const OPERATORS = ['&&', '||', ';;', ';', '|', '&', '\n'];
const REDIRECT_OPERATORS = ['&>>', '&>', '>>', '2>>', '2>', '>', '<<<', '<<', '<'];

function isOperatorAt(source: string, index: number): string | null {
  for (const op of OPERATORS) {
    if (source.startsWith(op, index)) return op;
  }
  return null;
}

function isRedirectAt(source: string, index: number): string | null {
  // Longest match first so `>>` is not read as two `>`.
  for (const op of REDIRECT_OPERATORS) {
    if (source.startsWith(op, index)) {
      // A digit immediately before `>` belongs to the operator (`2>`), and is
      // consumed by the caller; nothing to do here.
      return op;
    }
  }
  return null;
}

/**
 * Finds command substitutions and returns their inner commands.
 *
 * Both `$( … )` and backticks are handled, nesting included. The inner text is
 * returned rather than analysed here so the caller can run the full policy
 * over it recursively — a substitution is an ordinary command that happens to
 * be written inside another one.
 */
export function extractSubstitutions(source: string): string[] {
  const found: string[] = [];
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!;
    const prev = i > 0 ? source[i - 1] : '';

    if (ch === '\\' ) { i++; continue; }
    if (ch === "'" && !inDouble) { inSingle = !inSingle; continue; }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; continue; }
    // Single quotes suppress substitution; double quotes do not.
    if (inSingle) continue;

    if (ch === '(' && prev === '$') {
      let depth = 1;
      let j = i + 1;
      for (; j < source.length && depth > 0; j++) {
        if (source[j] === '(') depth++;
        else if (source[j] === ')') depth--;
      }
      const inner = source.slice(i + 1, j - 1);
      found.push(inner, ...extractSubstitutions(inner));
      i = j - 1;
      continue;
    }

    if (ch === '`') {
      const end = source.indexOf('`', i + 1);
      if (end === -1) break;
      const inner = source.slice(i + 1, end);
      found.push(inner, ...extractSubstitutions(inner));
      i = end;
    }
  }
  return found;
}

/**
 * Splits a command into segments, resolving quotes and collecting
 * redirections. Operators inside quotes are text, not separators — which is
 * exactly what a naive `String.split` gets wrong.
 */
export function parseCommand(source: string): ParsedCommand {
  const segments: ShellSegment[] = [];
  let words: string[] = [];
  let redirections: Redirection[] = [];
  let current = '';
  let currentHasContent = false;
  let segmentStart = 0;
  let pendingRedirect: string | null = null;

  const pushWord = () => {
    if (!currentHasContent) return;
    if (pendingRedirect) {
      redirections.push({ operator: pendingRedirect, target: current });
      pendingRedirect = null;
    } else {
      words.push(current);
    }
    current = '';
    currentHasContent = false;
  };

  const pushSegment = (endIndex: number) => {
    pushWord();
    if (words.length || redirections.length) {
      segments.push({ text: source.slice(segmentStart, endIndex).trim(), words, redirections });
    }
    words = [];
    redirections = [];
    segmentStart = endIndex + 1;
  };

  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!;

    if (ch === '\\') {
      const next = source[i + 1];
      if (next === undefined) continue;
      // A backslash before a word character is a Windows path separator, not
      // an escape: dropping it would turn `C:\tools\curl.exe` into a name no
      // policy recognises. Before a metacharacter it escapes, as in POSIX.
      if (/[A-Za-z0-9_.]/.test(next)) {
        current += ch;
        currentHasContent = true;
        continue;
      }
      current += next;
      currentHasContent = true;
      i++;
      continue;
    }

    if (ch === "'") {
      const end = source.indexOf("'", i + 1);
      const stop = end === -1 ? source.length : end;
      current += source.slice(i + 1, stop);
      currentHasContent = true;
      i = stop;
      continue;
    }

    if (ch === '"') {
      let j = i + 1;
      for (; j < source.length; j++) {
        // Inside double quotes a backslash escapes only $ ` " \ and newline.
        // Before anything else it is a literal character — which is what makes
        // "C:\Users\dev" a Windows path rather than the mangled C:Usersdev.
        // Treating every backslash as an escape turned an absolute path into a
        // relative one, and a containment check into a pass.
        if (source[j] === '\\' && DOUBLE_QUOTE_ESCAPABLE.has(source[j + 1] ?? '')) {
          current += source[j + 1];
          j++;
          continue;
        }
        if (source[j] === '"') break;
        current += source[j];
      }
      currentHasContent = true;
      i = j;
      continue;
    }

    const operator = isOperatorAt(source, i);
    if (operator) {
      pushSegment(i);
      i += operator.length - 1;
      segmentStart = i + 1;
      continue;
    }

    // `2>&1` and `1>&2` duplicate a file descriptor; they name no file. Read as
    // a redirection they produced a target of `&1`, and the workspace guard
    // then refused the command as destroying a file called `1` — so every
    // ordinary `npm test 2>&1` was blocked with a message about deleting
    // things.
    const duplication = /^(?:[0-9]*>&[0-9]+-?|[0-9]*<&[0-9]+-?)/.exec(source.slice(i));
    if (duplication) {
      // The leading descriptor may already have been read as part of a word.
      if (/^[0-9]$/.test(current) && currentHasContent) {
        current = '';
        currentHasContent = false;
      }
      pushWord();
      i += duplication[0].length - 1;
      continue;
    }

    const redirect = isRedirectAt(source, i);
    if (redirect) {
      // `2>` is written as a digit glued to the operator; that digit was read
      // as part of the current word, so take it back.
      if (redirect.startsWith('>') && current.endsWith('2') && currentHasContent && current.length === 1) {
        current = '';
        currentHasContent = false;
      }
      pushWord();
      pendingRedirect = redirect;
      i += redirect.length - 1;
      continue;
    }

    if (ch === ' ' || ch === '\t') { pushWord(); continue; }

    current += ch;
    currentHasContent = true;
  }
  pushSegment(source.length);

  return { segments, substitutions: extractSubstitutions(source) };
}
