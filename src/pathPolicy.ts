import { existsSync, lstatSync, readlinkSync } from 'fs';
import { homedir } from 'os';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'path';

let PROJECT_ROOT = resolve(process.cwd());

export function setProjectRoot(rootPath: string): void {
  PROJECT_ROOT = resolve(normalizeUserPath(rootPath));
}

export function getProjectRoot(): string {
  return PROJECT_ROOT;
}

/**
 * Expands a leading `~` to the current user's home directory.
 *
 * Models and UI copy often pass `~/…` or Windows `~\…` after seeing a
 * display cwd like `~\Desktop\proj`. Without this step, Node treats `~` as a
 * literal relative segment and produces
 * `C:\…\workspace\~\Desktop\proj` — which is exactly the ENOENT users hit.
 *
 * Only the bare home prefix is expanded (`~`, `~/…`, `~\…`). `~otheruser` is
 * left alone so we do not invent foreign home directories.
 */
export function expandUserPath(inputPath: string, home = homedir()): string {
  if (!inputPath) return inputPath;
  const trimmed = inputPath.trim();
  if (trimmed === '~') return home;
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    // Models and Windows UI use both ~\ and ~/. Split on either so Linux does
    // not keep a literal backslash in the path (`/home/u/Desktop\proj`).
    const rest = trimmed.slice(2);
    if (!rest) return home;
    const segments = rest.split(/[/\\]+/).filter(Boolean);
    return join(home, ...segments);
  }
  return inputPath;
}

/**
 * Repairs paths that already contain a literal `~` segment mid-path.
 *
 * Once something has done `resolve(workspace, "~\\Desktop\\proj")`, the damage
 * is baked in as `C:\…\workspace\~\Desktop\proj`. Leading-only expand cannot
 * see that. If a `~` appears as its own path component, re-expand from there.
 */
export function repairEmbeddedHomePath(inputPath: string, home = homedir()): string {
  if (!inputPath) return inputPath;
  const normalized = inputPath.replace(/\//g, sep);
  // Match \~ or /~ as a path component (not ~otheruser).
  const marker = `${sep}~`;
  const idx = normalized.indexOf(marker);
  if (idx === -1) {
    if (normalized === '~' || normalized.startsWith(`~${sep}`)) {
      return expandUserPath(normalized.replace(/\//g, sep), home);
    }
    return inputPath;
  }
  const after = normalized.slice(idx + 1); // starts with ~
  // ~otheruser — leave alone
  if (after.length > 1 && after[1] !== sep && after[1] !== undefined) {
    return inputPath;
  }
  return expandUserPath(after, home);
}

/** Expand leading ~ and repair mid-path `~\…` corruption. */
export function normalizeUserPath(inputPath: string, home = homedir()): string {
  return repairEmbeddedHomePath(expandUserPath(inputPath, home), home);
}

/**
 * Short form for status bars and pickers only — never feed this string back
 * into tools or session storage as a real path.
 */
export function toDisplayHomePath(absolutePath: string, home = homedir()): string {
  const abs = resolve(normalizeUserPath(absolutePath, home));
  const homeAbs = resolve(home);
  if (abs === homeAbs) return '~';
  const prefix = homeAbs.endsWith(sep) ? homeAbs : homeAbs + sep;
  if (abs.startsWith(prefix)) {
    return '~' + sep + abs.slice(prefix.length);
  }
  return abs;
}

export function resolveSafePath(inputPath: string, basePath = PROJECT_ROOT): string {
  const expanded = normalizeUserPath(inputPath);
  const base = normalizeUserPath(basePath);
  return isAbsolute(expanded) ? resolve(expanded) : resolve(base, expanded);
}

/** Upper bound on symlink hops per component, mirroring the kernel's own limit. */
const MAX_SYMLINK_HOPS = 40;

/**
 * Resolves a path the way the filesystem will, following symlinks at every
 * level — including links whose target does not exist yet.
 *
 * `fs.realpathSync` cannot be used on its own here. It throws for any path
 * that is not fully present, which is the normal case when the agent is about
 * to create a file, and it throws for a dangling symlink even though writing
 * through that link would still land wherever the link points.
 *
 * Walking component by component covers both: each existing component is
 * dereferenced, and a component that does not exist simply cannot be a link,
 * so the remainder is appended as written.
 */
function resolveRealPath(inputPath: string, budget = MAX_SYMLINK_HOPS): string {
  const absolute = resolve(inputPath);
  const { root } = parse(absolute);
  const components = absolute.slice(root.length).split(sep).filter(Boolean);

  let current = root;
  for (let index = 0; index < components.length; index++) {
    current = join(current, components[index]!);

    for (let hop = 0; hop < MAX_SYMLINK_HOPS; hop++) {
      let target: string;
      try {
        if (!lstatSync(current).isSymbolicLink()) break;
        target = readlinkSync(current);
      } catch {
        // Nothing at this location: it cannot redirect anywhere.
        break;
      }

      if (isAbsolute(target)) {
        // The target's own ancestors may be links as well, and continuing from
        // here would leave them unresolved. On macOS that is the ordinary case:
        // /var is a link to /private/var, so a workspace under /var and a file
        // reached through a link inside it resolve to different prefixes, and a
        // file plainly inside the workspace gets refused as foreign.
        if (budget <= 0) return current;
        const rest = components.slice(index + 1);
        return resolveRealPath(rest.length ? join(target, ...rest) : target, budget - 1);
      }
      current = resolve(dirname(current), target);
    }
  }
  return current;
}

/**
 * Whether a path stays inside the workspace root once symlinks are followed.
 *
 * Comparing resolved strings alone is not enough. A link placed inside the
 * root and pointing outside it produces a path that reads as contained while
 * the file it designates is not — and the agent reads repositories it did not
 * write, so such a link is not a hypothetical.
 */
export function isPathInsideRoot(inputPath: string, rootPath = PROJECT_ROOT): boolean {
  try {
    const root = resolve(normalizeUserPath(rootPath));
    const realRoot = resolveRealPath(root);
    const realPath = resolveRealPath(resolveSafePath(inputPath, root));
    const rel = relative(realRoot, realPath);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  } catch {
    return false;
  }
}

/** The location a path actually designates, for messages and audit records. */
export function describeRealPath(inputPath: string, rootPath = PROJECT_ROOT): string {
  const root = resolve(normalizeUserPath(rootPath));
  return resolveRealPath(resolveSafePath(inputPath, root));
}

/**
 * Written for the model, which is what actually reads it.
 *
 * The previous wording ended with "use /cd … then retry" — but `/cd` is a
 * slash command only the operator can type, so the instruction named an
 * action the reader cannot perform. What followed was a retry loop.
 */
export function formatPathOutsideRootMessage(inputPath: string, rootPath = PROJECT_ROOT): string {
  const requested = resolveSafePath(inputPath, rootPath);
  const actual = resolveRealPath(requested);
  const lines = [`Blocked: path is outside the workspace.`, `  requested: ${requested}`];

  // A link is worth naming: the requested path looks contained, so without
  // this line the refusal reads as a false positive.
  if (actual !== requested) {
    lines.push(`  resolves through a symlink to: ${actual}`);
  }

  lines.push(
    `  workspace: ${resolve(rootPath)}`,
    '',
    'You cannot change the workspace root yourself — no tool does that.',
    'Do not retry with a different spelling of the same path.',
    `Either work inside the workspace, or ask the operator to run /cd "${actual}".`
  );
  return lines.join('\n');
}

export function ensurePathExists(inputPath: string): boolean {
  return existsSync(inputPath);
}

export function ensureDirectory(inputPath: string): boolean {
  try {
    return lstatSync(inputPath).isDirectory();
  } catch {
    return false;
  }
}
