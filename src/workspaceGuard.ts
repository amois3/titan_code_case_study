import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { resolve, sep } from 'path';
import { parseCommand, type ShellSegment } from './shellLexer';
import { describeSegment } from './shellPolicy';

/**
 * Stops a shell command from destroying work that exists nowhere else.
 *
 * The dangerous-command patterns guard the machine — `rm -rf /`, mkfs, dd, a
 * fork bomb — and the path policy guards everything outside the workspace.
 * Inside it there was nothing at all: `git reset --hard`, `git clean -fd` and
 * `rm -rf src` all ran on a single keypress at the confirm bar, and what they
 * take is the one category of work with no copy anywhere. A committed file is
 * recoverable and a pushed branch is safe; an hour of uncommitted editing is
 * gone the moment one of these succeeds.
 *
 * The test is not what the command is called but what it would cost. Every one
 * of these is routine and harmless against a clean tree — `git reset --hard`
 * after a successful merge, `git clean -fd` to clear build output — so refusing
 * them by name would make the agent useless at exactly the moments it should be
 * tidying up. Git is asked what would actually be lost, and the answer decides.
 */

export type DestructiveKind =
  | 'discard-tracked'   // throws away modifications to tracked files
  | 'delete-untracked'  // removes files git is not holding a copy of
  | 'delete-path';      // removes a path outright

export interface DestructiveIntent {
  kind: DestructiveKind;
  /** How the command reads, for the refusal. */
  description: string;
  /**
   * Paths this command reaches, when it names them.
   *
   * Scope decides whether a guard is kept or switched off. `echo x > new.ts`
   * touches one file that does not exist yet; judging it against every
   * uncommitted change in the repository would refuse ordinary work for the
   * whole time a branch is in progress, and a guard that blocks ordinary work
   * gets disabled and then protects nothing. Absent means the command reaches
   * the whole tree, which is true of git reset --hard and git clean.
   */
  targets?: string[];
}

export interface WorkspaceGuardVerdict {
  allowed: boolean;
  reason?: string;
}

/**
 * git's own options come before the subcommand, and take the subcommand's
 * place if they are skipped: in `git -C . reset --hard` the second word is
 * `-C`, so a guard reading word two sees no subcommand and lets it through.
 */
function gitSubcommand(words: string[]): { sub: string; rest: string[] } | null {
  let i = 1;
  while (i < words.length) {
    const word = words[i]!;
    if (!word.startsWith('-')) {
      return { sub: word.toLowerCase(), rest: words.slice(i + 1).map((w) => w.toLowerCase()) };
    }
    // The options that take a value of their own.
    i += /^(-C|-c|--git-dir|--work-tree|--namespace|--exec-path)$/.test(word) ? 2 : 1;
  }
  return null;
}

/**
 * Emptying a file is destroying it, and nothing here was looking.
 *
 * `> src/main.ts` truncates on the redirect alone, before any program runs, so
 * there is no command name to recognise. `truncate -s 0` and `sed -i` do the
 * same thing through a program instead.
 */
function classifyTruncation(segment: ShellSegment): DestructiveIntent | null {
  for (const redirection of segment.redirections) {
    // `>>` appends, `2>` is a stream. Only a truncating write to a path.
    if (redirection.operator !== '>' && redirection.operator !== '&>') continue;
    const target = redirection.target;
    if (!target || target.startsWith('&') || /^\/dev\//.test(target)) continue;
    return { kind: 'delete-path', description: `> ${target}`, targets: [target] };
  }
  return null;
}

/** What this command would take, or null if it takes nothing. */
export function classifyDestructive(command: string, depth = 0): DestructiveIntent | null {
  if (depth > 4) return null;

  let segments: ShellSegment[];
  try {
    segments = parseCommand(command).segments;
  } catch {
    return null;
  }

  for (const rawSegment of segments) {
    const truncation = classifyTruncation(rawSegment);
    if (truncation) return truncation;

    // Wrappers stripped, so `env timeout 5s git reset --hard` is seen for what
    // it is. Writing this by hand is how the first version of this guard saw
    // through none of them.
    const { names, inlineScripts, words: segment } = describeSegment(rawSegment);
    if (segment.length === 0) continue;

    // `bash -c "git reset --hard"` hides a whole command inside an argument.
    for (const script of inlineScripts) {
      const nested = classifyDestructive(script, depth + 1);
      if (nested) return nested;
    }

    if (names.includes('git')) {
      const parsed = gitSubcommand(segment);
      const sub = parsed?.sub;
      const rest = parsed?.rest ?? [];

      if (sub === 'reset' && rest.includes('--hard')) {
        return { kind: 'discard-tracked', description: 'git reset --hard' };
      }
      // `git checkout -- .` and `git checkout .` restore files over the top of
      // whatever is in the working tree. `git checkout branch` does not.
      if (sub === 'checkout' && (rest.includes('--') || rest.some((word) => word === '.' || word.startsWith('./')))) {
        return { kind: 'discard-tracked', description: 'git checkout of working-tree paths' };
      }
      if (sub === 'restore' && !rest.includes('--staged')) {
        return { kind: 'discard-tracked', description: 'git restore' };
      }
      if (sub === 'clean' && rest.some((word) => /^-[a-z]*f/.test(word))) {
        return { kind: 'delete-untracked', description: 'git clean -f' };
      }
      if (sub === 'stash' && (rest.includes('clear') || rest.includes('drop'))) {
        return { kind: 'discard-tracked', description: `git stash ${rest[0]}` };
      }
      if (sub === 'worktree' && rest.includes('remove')) {
        return { kind: 'delete-path', description: 'git worktree remove' };
      }
      continue;
    }

    // The effective program, so a full path or a wrapper does not hide it.
    const name = names.at(-1) ?? '';
    const args = segment.slice(1);
    const paths = args.filter((word) => !word.startsWith('-'));

    if (name === 'rm' && args.some((word) => /^-[a-zA-Z]*r/.test(word))) {
      return { kind: 'delete-path', description: segment.join(' '), targets: paths };
    }
    if (name === 'find' && args.includes('-delete')) {
      // `find src -name '*.ts' -delete` reaches only what it was pointed at.
      return { kind: 'delete-path', description: segment.join(' '), targets: paths.slice(0, 1) };
    }
    // Emptying a file in place destroys it as surely as deleting it.
    if (name === 'truncate' && args.some((word) => /^-s$/.test(word) || /^--size/.test(word))) {
      return { kind: 'delete-path', description: segment.join(' '), targets: paths };
    }
    if (name === 'sed' && args.some((word) => /^-[a-zA-Z]*i/.test(word))) {
      return { kind: 'delete-path', description: segment.join(' '), targets: paths.slice(1) };
    }
    // `mv` is deliberately absent. A rename keeps the contents, so it destroys
    // nothing; moving a path out of the workspace is a write outside the root,
    // which the path policy already refuses. Flagging every rename would refuse
    // ordinary work for as long as a branch had uncommitted changes on it.
  }

  return null;
}

interface WorkingTree {
  isRepo: boolean;
  modifiedTracked: string[];
  untracked: string[];
}

function readWorkingTree(cwd: string): WorkingTree {
  const result = spawnSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
    cwd,
    encoding: 'utf-8',
    timeout: 10_000,
    windowsHide: true
  });

  if (result.error || result.status !== 0) {
    return { isRepo: false, modifiedTracked: [], untracked: [] };
  }

  const modifiedTracked: string[] = [];
  const untracked: string[] = [];
  for (const line of (result.stdout || '').split('\n')) {
    if (!line.trim()) continue;
    const status = line.slice(0, 2);
    const path = line.slice(3).trim();
    // The CLI's own edit backups are not the user's work. They are untracked,
    // so without this every file the agent had touched would count as
    // something to lose, and `git clean` would be refused on the strength of
    // litter this tool dropped itself.
    if (/\.titan-backup$/.test(path)) continue;
    if (status === '??') untracked.push(path);
    else modifiedTracked.push(path);
  }
  return { isRepo: true, modifiedTracked, untracked };
}

/**
 * Narrows what is at risk to what the command actually reaches.
 *
 * Without this, `echo x > notes.txt` on a branch with any uncommitted change
 * is refused because the repository is dirty somewhere, which has nothing to
 * do with notes.txt. A guard that refuses ordinary work is a guard that gets
 * turned off.
 */
function scopeToTargets(candidates: string[], targets: string[] | undefined, cwd: string): string[] {
  if (!targets || targets.length === 0) return candidates;

  const roots = targets
    .filter((target) => !/^\/dev\//.test(target))
    .map((target) => resolve(cwd, target.replace(/^["']|["']$/g, '')));

  return candidates.filter((relative) => {
    const absolute = resolve(cwd, relative);
    return roots.some((root) => absolute === root || absolute.startsWith(root + sep) || root === cwd);
  });
}

/**
 * Whether a named target is something that could be lost.
 *
 * A pattern is not resolved here — `rm -rf build/*` names no file that exists
 * under that spelling, and taking that as "nothing to lose" would wave through
 * exactly the command this guard is for. Anything with a wildcard in it counts
 * as reaching something until proven otherwise.
 */
function targetMayExist(target: string, cwd: string): boolean {
  const path = target.replace(/^["']|["']$/g, '');
  if (!path || /^\/dev\//.test(path)) return false;
  if (/[*?[\]]/.test(path)) return true;
  try {
    return existsSync(resolve(cwd, path));
  } catch {
    // An unresolvable path is not something to reason about; leave the rest of
    // the guard to judge it.
    return true;
  }
}

function list(paths: string[], limit = 5): string {
  const shown = paths.slice(0, limit).map((path) => `  ${path}`);
  if (paths.length > limit) shown.push(`  …and ${paths.length - limit} more`);
  return shown.join('\n');
}

/**
 * Whether this command may run against the work currently in the tree.
 *
 * `cwd` is where git is asked, so the answer is about the repository the
 * command would actually affect.
 */
export function checkWorkspaceDestruction(command: string, cwd: string): WorkspaceGuardVerdict {
  let intent = classifyDestructive(command);
  if (!intent) return { allowed: true };

  // A path that does not exist yet cannot be destroyed. Creating a file by
  // redirection — `echo x > out.txt` — reads as a truncating write, and
  // outside a repository every such write was refused with a message about
  // things being unrecoverable, which is how the guard blocked the most
  // ordinary thing a shell does.
  if (intent.targets?.length) {
    const real = intent.targets.filter((target) => targetMayExist(target, cwd));
    if (real.length === 0) return { allowed: true };
    intent = { ...intent, targets: real };
  }

  const tree = readWorkingTree(resolve(cwd));

  // Outside a repository there is no undo of any kind, so a recursive delete
  // is the one thing that cannot be walked back. Git commands are moot here.
  if (!tree.isRepo) {
    if (intent.kind === 'delete-path') {
      return {
        allowed: false,
        reason: [
          `Refusing: ${intent.description}`,
          '',
          'This directory is not a git repository, so nothing here is recoverable once deleted.',
          'Move what should go, or ask the user to delete it themselves.'
        ].join('\n')
      };
    }
    return { allowed: true };
  }

  const candidates = intent.kind === 'delete-untracked'
    ? tree.untracked
    : intent.kind === 'discard-tracked'
      ? tree.modifiedTracked
      : [...tree.modifiedTracked, ...tree.untracked];

  const atRisk = scopeToTargets(candidates, intent.targets, resolve(cwd));

  if (atRisk.length === 0) {
    // Routine tidying against a clean tree. This is the case that makes a
    // name-based ban wrong.
    return { allowed: true };
  }

  // Pluralised as whole phrases: appending an s to "file with uncommitted
  // changes" produces "changess", which it duly did.
  const nouns: Record<DestructiveKind, [string, string]> = {
    'discard-tracked': ['file with uncommitted changes', 'files with uncommitted changes'],
    'delete-untracked': ['untracked file', 'untracked files'],
    'delete-path': ['uncommitted or untracked file', 'uncommitted and untracked files']
  };
  const single = atRisk.length === 1;
  const noun = nouns[intent.kind][single ? 0 : 1];

  return {
    allowed: false,
    reason: [
      `Refusing: ${intent.description}`,
      '',
      `${atRisk.length} ${noun} would be lost, and git has no copy of ${single ? 'it' : 'them'}:`,
      list(atRisk),
      '',
      'Commit or stash the work first, and the same command goes through against a clean tree.',
      'If losing it is the intention, the user has to do that themselves.'
    ].join('\n')
  };
}
