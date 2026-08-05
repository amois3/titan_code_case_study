import { basename, resolve, isAbsolute } from 'path';
import { isPathInsideRoot, describeRealPath } from './pathPolicy';
import { parseCommand, type ShellSegment } from './shellLexer';

const DEFAULT_DENIED_COMMANDS = new Set([
  'curl',
  'wget',
  'ssh',
  'scp',
  'sftp',
  'rsync',
  'ftp',
  'telnet',
  'nc',
  'ncat',
  'netcat',
  'sudo',
  'su',
  'doas'
]);

const DEFAULT_ALLOWED_ENV_KEYS = new Set([
  'HOME',
  'PATH',
  'TERM',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'USER',
  'LOGNAME',
  'PWD',
  'SHELL',
  'TMPDIR',
  // Windows equivalents: without these a spawned process cannot even locate
  // the system directory or a temporary file.
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'USERNAME',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'PROCESSOR_ARCHITECTURE',
  'NUMBER_OF_PROCESSORS'
]);

/**
 * Commands that hand execution to whatever follows them. Reading only the
 * first word of `env curl …` or `xargs curl` reports `env` and `xargs`, which
 * are harmless names for a call that is not.
 */
const PASSTHROUGH_WRAPPERS = new Set([
  'env', 'command', 'builtin', 'exec', 'nohup', 'nice', 'ionice',
  'setsid', 'stdbuf', 'timeout', 'time', 'watch', 'xargs', 'sudo', 'doas'
]);

/** Interpreters that take a program on the command line rather than a file. */
const INLINE_SCRIPT_RUNNERS = new Map<string, string[]>([
  ['bash', ['-c']],
  ['sh', ['-c']],
  ['zsh', ['-c']],
  ['dash', ['-c']],
  ['ksh', ['-c']],
  ['fish', ['-c']],
  ['pwsh', ['-c', '-command', '-Command', '-EncodedCommand']],
  ['powershell', ['-c', '-command', '-Command', '-EncodedCommand']],
  ['cmd', ['/c', '/C', '/k', '/K']],
  ['python', ['-c']],
  ['python3', ['-c']],
  ['perl', ['-e', '-E']],
  ['ruby', ['-e']],
  ['node', ['-e', '--eval', '-p', '--print']],
  ['deno', ['eval']],
  ['bun', ['-e', '--eval']]
]);

/** Redirections that create or overwrite a file. */
const WRITING_REDIRECTS = new Set(['>', '>>', '2>', '2>>', '&>', '&>>']);

/**
 * Commands that write to a path given as an argument rather than through a
 * redirection. `echo x | tee /etc/thing` writes outside the workspace without
 * ever using `>`, so checking redirections alone leaves the same hole open by
 * a different spelling.
 *
 * `where` says which arguments name the destination: every non-flag argument,
 * or only the last one for the copy-shaped commands.
 */
const ARGUMENT_WRITERS = new Map<string, 'all' | 'last'>([
  ['tee', 'all'],
  ['truncate', 'all'],
  ['touch', 'all'],
  ['mkdir', 'all'],
  ['rmdir', 'all'],
  ['cp', 'last'],
  ['mv', 'last'],
  ['ln', 'last'],
  ['install', 'last'],
  ['rsync', 'last']
]);

/** Destination paths a writer command will touch, ignoring its flags. */
function writeTargets(words: string[]): string[] {
  const mode = ARGUMENT_WRITERS.get(normalizeCommandName(words[0] ?? ''));
  if (!mode) return [];

  const operands: string[] = [];
  for (let i = 1; i < words.length; i++) {
    const word = words[i]!;
    if (word.startsWith('-')) {
      // `dd of=…` style is handled below; ordinary flags carry no destination.
      continue;
    }
    operands.push(word);
  }
  if (!operands.length) return [];
  return mode === 'all' ? operands : operands.slice(-1);
}

export interface ShellPolicyDecision {
  allowed: boolean;
  reason?: string;
  commandName?: string;
  segment?: string;
  suggestion?: string;
}

export interface ShellEnvOptions {
  env?: NodeJS.ProcessEnv;
}

function parseCsvList(value: string | undefined): string[] {
  return (value || '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

/**
 * Reduces an invocation to the name a policy can reason about: no directory,
 * no `.exe`, lower case. `/usr/bin/curl`, `./curl` and `CURL.EXE` are the same
 * program and must be judged the same way.
 */
function normalizeCommandName(word: string): string {
  const withoutQuotes = word.replace(/^['"]|['"]$/g, '');
  const name = basename(withoutQuotes.replace(/\\/g, '/'));
  return name.replace(/\.(exe|cmd|bat|com)$/i, '').trim().toLowerCase();
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

export function getShellAllowlist(): string[] {
  return parseCsvList(process.env.TITAN_CODE_SHELL_ALLOWLIST).map(name => name.trim().toLowerCase());
}

export function getShellDenylist(): string[] {
  const configured = parseCsvList(process.env.TITAN_CODE_SHELL_DENYLIST).map(name => name.trim().toLowerCase());
  return Array.from(new Set([...Array.from(DEFAULT_DENIED_COMMANDS), ...configured]));
}

export function buildShellEnv(options: ShellEnvOptions = {}): NodeJS.ProcessEnv {
  const source = options.env || process.env;
  const extraAllowlist = new Set(parseCsvList(source.TITAN_CODE_SHELL_ENV_ALLOWLIST).map(k => k.trim().toUpperCase()));
  const allowedEnvKeys = new Set<string>([
    ...Array.from(DEFAULT_ALLOWED_ENV_KEYS),
    ...Array.from(extraAllowlist)
  ]);

  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (!allowedEnvKeys.has(key.toUpperCase())) continue;
    if (value !== undefined) env[key] = value;
  }

  env.PAGER = 'cat';
  env.LESS = 'FRX';
  return env;
}

/** Kept for callers that only need the segment texts. */
export function splitShellSegments(command: string): string[] {
  return parseCommand(command).segments.map(segment => segment.text).filter(Boolean);
}

/**
 * The program a segment actually runs, seen through assignments and wrappers.
 *
 * Also reports any inline script so the caller can analyse it: `bash -c "curl
 * …"` runs curl, and a policy that stops at `bash` has not looked.
 */
export function describeSegment(segment: ShellSegment): { names: string[]; inlineScripts: string[] } {
  const inlineScripts: string[] = [];
  const names: string[] = [];
  let words = segment.words.slice();

  for (let guard = 0; guard < 16; guard++) {
    while (words.length && ASSIGNMENT.test(words[0]!)) words = words.slice(1);
    if (!words.length) break;

    const name = normalizeCommandName(words[0]!);
    if (!name) break;
    // Every name in the chain is reported, not just the last. A wrapper can be
    // forbidden in its own right — `sudo rm` must be refused for the sudo, and
    // unwrapping first would hide exactly that.
    names.push(name);

    const scriptFlags = INLINE_SCRIPT_RUNNERS.get(name);
    if (scriptFlags) {
      for (let i = 1; i < words.length; i++) {
        if (scriptFlags.includes(words[i]!) && words[i + 1] !== undefined) {
          inlineScripts.push(words[i + 1]!);
        }
      }
      break;
    }

    if (PASSTHROUGH_WRAPPERS.has(name) && words.length > 1) {
      // Skip the wrapper's own options so the wrapped program is found:
      // `timeout 5s curl …`, `xargs -I{} curl …`.
      let next = 1;
      while (next < words.length && (words[next]!.startsWith('-') || ASSIGNMENT.test(words[next]!) || /^\d+[smhd]?$/.test(words[next]!))) {
        next++;
      }
      if (next >= words.length) break;
      words = words.slice(next);
      continue;
    }

    break;
  }
  return { names, inlineScripts };
}

export function extractCommandName(segment: string): string {
  const parsed = parseCommand(segment);
  const first = parsed.segments[0];
  if (!first) return '';
  const { names } = describeSegment(first);
  // The effective program is the innermost one: `env npm test` runs npm.
  return names.length ? names[names.length - 1]! : '';
}

/**
 * A refusal aimed at whoever can act on it.
 *
 * This message is read by the model, and the model has no tool for changing
 * the workspace root — `/cd` is a slash command only the operator can type.
 * Telling it to run `/cd` therefore describes an impossible action, and the
 * observed result was the model rewriting the same command six ways in a row,
 * escaping the backslashes differently each time, until the turn ran out.
 *
 * So: state where the boundary is, say plainly that it cannot be moved from
 * here, and give the one instruction that ends the loop — stop retrying.
 */
function outsideWorkspaceMessage(name: string, target: string, resolvedTarget: string, cwdRoot: string): string {
  return [
    `Blocked: ${name} would leave the workspace.`,
    `  requested: ${target}`,
    ...(resolvedTarget !== target ? [`  resolves to: ${resolvedTarget}`] : []),
    `  workspace: ${cwdRoot}`,
    '',
    'You cannot change the workspace root yourself — no tool does that.',
    'Do not retry this command in another spelling; the answer will not change.',
    `Either work inside ${cwdRoot}, or ask the operator to run /cd "${resolvedTarget}".`
  ].join('\n');
}

export function detectCwdEscape(segment: string, cwdRoot: string): string | null {
  const parsed = parseCommand(segment);
  for (const parsedSegment of parsed.segments) {
    const words = parsedSegment.words.filter(word => !ASSIGNMENT.test(word));
    const name = words.length ? normalizeCommandName(words[0]!) : '';
    if (name !== 'cd' && name !== 'pushd') continue;

    const targetRaw = (words[1] ?? '').trim();
    if (!targetRaw || targetRaw === '-') {
      return [
        `Blocked: bare ${name} would leave the workspace.`,
        `  workspace: ${cwdRoot}`,
        '',
        `Commands already run in ${cwdRoot}; there is no need to cd into it.`,
        'Use a path relative to the workspace instead.'
      ].join('\n');
    }

    const home = process.env.HOME || process.env.USERPROFILE || '';
    const expanded = targetRaw.startsWith('~') && home
      ? resolve(home, targetRaw.slice(1).replace(/^[\\/]/, ''))
      : targetRaw;

    const resolvedTarget = isAbsolute(expanded) ? resolve(expanded) : resolve(cwdRoot, expanded);
    if (!isPathInsideRoot(resolvedTarget, cwdRoot)) {
      return outsideWorkspaceMessage(name, targetRaw, resolvedTarget, cwdRoot);
    }
  }
  return null;
}

/**
 * A refusal is only useful if it says what to do instead. Without a route
 * forward the agent retries the same blocked command, which wastes a turn and
 * teaches it nothing.
 */
const DENIAL_SUGGESTIONS = new Map<string, string>([
  ['curl', 'HTTP probing via shell is blocked. Use the fetch(url, method?, headers?, body?) tool for API/UI health checks.'],
  ['wget', 'HTTP probing via shell is blocked. Use the fetch(url, method?, headers?, body?) tool for API/UI health checks.'],
  ['sudo', 'Use a non-root alternative such as python3 -m venv, pip install --user, or a project-local toolchain.'],
  ['su', 'Use a non-root alternative such as python3 -m venv, pip install --user, or a project-local toolchain.'],
  ['doas', 'Use a non-root alternative such as python3 -m venv, pip install --user, or a project-local toolchain.']
]);

function denyDecision(commandName: string, segment: string): ShellPolicyDecision {
  return {
    allowed: false,
    reason: `Shell command blocked by denylist: ${commandName}`,
    commandName,
    segment,
    suggestion: DENIAL_SUGGESTIONS.get(commandName)
      ?? 'Use an allowed non-root command or adjust the shell policy only if this is intentional.'
  };
}

/**
 * Decides whether a shell command may run.
 *
 * The command is parsed rather than pattern-matched, and the same policy is
 * applied to everything it can reach: each segment, every command
 * substitution, and any inline script handed to an interpreter. Redirection
 * targets are checked against the workspace root, because a write is a write
 * whether it comes from a tool call or from `>`.
 */
export function checkShellPolicy(command: string, cwdRoot: string, depth = 0): ShellPolicyDecision {
  if (depth > 8) {
    return { allowed: false, reason: 'Shell command nested too deeply to analyse safely', segment: command };
  }

  const parsed = parseCommand(command);
  const allowlist = getShellAllowlist();
  const denylist = getShellDenylist();
  const hasAllowlist = allowlist.length > 0;

  // A substitution runs before the command that contains it, so it is checked
  // first — and with the identical policy.
  for (const substitution of parsed.substitutions) {
    const nested = checkShellPolicy(substitution, cwdRoot, depth + 1);
    if (!nested.allowed) {
      return {
        ...nested,
        reason: `${nested.reason} (inside command substitution)`,
        segment: substitution
      };
    }
  }

  for (const segment of parsed.segments) {
    const cwdEscapeReason = detectCwdEscape(segment.text, cwdRoot);
    if (cwdEscapeReason) return { allowed: false, reason: cwdEscapeReason, segment: segment.text };

    for (const redirection of segment.redirections) {
      if (!WRITING_REDIRECTS.has(redirection.operator)) continue;
      const target = redirection.target;
      if (!target || target.startsWith('&')) continue; // `2>&1` duplicates a descriptor
      if (!isPathInsideRoot(target, cwdRoot)) {
        return {
          allowed: false,
          reason: `Shell redirection outside workspace root: ${redirection.operator} ${target}\nResolves to: ${describeRealPath(target, cwdRoot)}`,
          segment: segment.text,
          suggestion: 'Write inside the workspace, or switch the root with /cd first.'
        };
      }
    }

    // `dd of=/etc/thing` names its destination in an assignment-shaped
    // argument, which no generic rule would spot.
    const ddTarget = segment.words.find(word => /^of=/i.test(word));
    if (ddTarget) {
      const target = ddTarget.slice(3);
      if (target && !isPathInsideRoot(target, cwdRoot)) {
        return {
          allowed: false,
          reason: `Shell write outside workspace root: of=${target}\nResolves to: ${describeRealPath(target, cwdRoot)}`,
          segment: segment.text,
          suggestion: 'Write inside the workspace, or switch the root with /cd first.'
        };
      }
    }

    for (const target of writeTargets(segment.words)) {
      if (!isPathInsideRoot(target, cwdRoot)) {
        return {
          allowed: false,
          reason: `Shell write outside workspace root: ${normalizeCommandName(segment.words[0]!)} ${target}\nResolves to: ${describeRealPath(target, cwdRoot)}`,
          segment: segment.text,
          suggestion: 'Write inside the workspace, or switch the root with /cd first.'
        };
      }
    }

    const { names, inlineScripts } = describeSegment(segment);
    if (!names.length) continue;

    // Judge every name in the chain: a forbidden wrapper is forbidden even
    // when what it wraps would be fine on its own.
    for (const name of names) {
      if (denylist.includes(name)) return denyDecision(name, segment.text);
    }

    // The allowlist applies to the program that actually runs. Requiring the
    // wrappers to be listed as well would make `env npm test` fail for a
    // reason the user cannot act on.
    const effective = names[names.length - 1]!;
    if (hasAllowlist && !allowlist.includes(effective)) {
      return {
        allowed: false,
        reason: `Shell command blocked by allowlist: ${effective}`,
        commandName: effective,
        segment: segment.text,
        suggestion: 'Use a command already on the allowlist or extend the allowlist intentionally.'
      };
    }

    for (const script of inlineScripts) {
      const nested = checkShellPolicy(script, cwdRoot, depth + 1);
      if (!nested.allowed) {
        return {
          ...nested,
          reason: `${nested.reason} (inside ${effective} script)`,
          segment: segment.text
        };
      }
    }
  }

  return { allowed: true };
}
