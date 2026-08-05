import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { join, resolve, sep } from 'path';
import { tmpdir } from 'os';
import { homedir } from 'os';
import {
  describeRealPath,
  expandUserPath,
  getProjectRoot,
  isPathInsideRoot,
  normalizeUserPath,
  resolveSafePath,
  setProjectRoot,
  toDisplayHomePath
} from './pathPolicy';

describe('pathPolicy', () => {
  it('tracks the active project root dynamically', () => {
    const firstRoot = mkdtempSync(join(tmpdir(), 'titan-root-a-'));
    const secondRoot = mkdtempSync(join(tmpdir(), 'titan-root-b-'));

    setProjectRoot(firstRoot);
    expect(getProjectRoot()).toBe(firstRoot);
    expect(resolveSafePath('subdir')).toBe(join(firstRoot, 'subdir'));
    expect(isPathInsideRoot(join(firstRoot, 'subdir'))).toBe(true);

    setProjectRoot(secondRoot);
    expect(getProjectRoot()).toBe(secondRoot);
    expect(resolveSafePath('subdir')).toBe(join(secondRoot, 'subdir'));
    expect(isPathInsideRoot(join(firstRoot, 'subdir'))).toBe(false);
    expect(isPathInsideRoot(join(secondRoot, 'subdir'))).toBe(true);
  });
});

describe('expandUserPath', () => {
  const home = homedir();

  it('expands bare ~ and slash forms to the real home directory', () => {
    expect(expandUserPath('~', home)).toBe(home);
    expect(expandUserPath('~/Desktop/proj', home)).toBe(join(home, 'Desktop', 'proj'));
    // Windows-style separators must not survive on POSIX as a literal `\`.
    expect(expandUserPath('~\\Desktop\\proj', home)).toBe(join(home, 'Desktop', 'proj'));
    expect(expandUserPath('~\\Desktop\\proj', home).includes('\\')).toBe(process.platform === 'win32');
  });

  it('does not invent a foreign home for ~otheruser', () => {
    expect(expandUserPath('~other/path', home)).toBe('~other/path');
  });

  it('does not glue ~ onto the workspace as a literal segment', () => {
    // Regression for: scandir 'C:\…\workspace\~\Desktop\…'
    const workspace = join(home, 'Desktop', 's_t_t');
    setProjectRoot(workspace);
    const resolved = resolveSafePath('~\\Desktop\\s_t_t', workspace);
    expect(resolved).toBe(resolve(workspace));
    expect(resolved.includes(`${sep}~${sep}`) || resolved.includes('\\~\\') || resolved.includes('/~/')).toBe(false);
    expect(isPathInsideRoot('~\\Desktop\\s_t_t', workspace)).toBe(true);
    expect(isPathInsideRoot('~/Desktop/s_t_t', workspace)).toBe(true);
  });

  it('keeps display form separate from tool resolution', () => {
    const workspace = join(home, 'Desktop', 's_t_t');
    const display = toDisplayHomePath(workspace, home);
    expect(display.startsWith('~')).toBe(true);
    expect(resolveSafePath(display, workspace)).toBe(resolve(workspace));
  });

  it('repairs a root that already contains a literal ~ segment', () => {
    // After a bad join: workspace + ~\Desktop\s_t_t
    const workspace = join(home, 'Desktop', 's_t_t');
    const corrupt = join(workspace, '~', 'Desktop', 's_t_t');
    expect(normalizeUserPath(corrupt, home)).toBe(resolve(workspace));
    setProjectRoot(corrupt);
    expect(getProjectRoot()).toBe(resolve(workspace));
    expect(resolveSafePath('.', corrupt)).toBe(resolve(workspace));
    expect(isPathInsideRoot(workspace, corrupt)).toBe(true);
  });
});

/**
 * Creating a link needs elevation or developer mode on Windows, and the two
 * kinds differ: a directory junction is allowed to an unprivileged user while
 * a file symlink is not. Each case therefore probes its own link rather than
 * trusting one capability check, and skips when the link could not be made —
 * a green run must never imply coverage it does not have.
 */
function tryLink(target: string, path: string, type: 'junction' | 'file'): boolean {
  try {
    symlinkSync(target, path, type);
    return true;
  } catch {
    return false;
  }
}

describe('pathPolicy containment', () => {
  let base: string;
  let root: string;
  let outside: string;


  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), 'titan-path-'));
    root = join(base, 'workspace');
    outside = join(base, 'outside');
    mkdirSync(root, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'secret.txt'), 'not for the agent');
    writeFileSync(join(root, 'own.txt'), 'belongs to the workspace');

  });

  afterAll(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('accepts files inside the root', () => {
    expect(isPathInsideRoot(join(root, 'own.txt'), root)).toBe(true);
    expect(isPathInsideRoot('own.txt', root)).toBe(true);
    expect(isPathInsideRoot(root, root)).toBe(true);
  });

  it('accepts a file that does not exist yet', () => {
    expect(isPathInsideRoot(join(root, 'deep', 'new', 'file.txt'), root)).toBe(true);
  });

  it('rejects traversal with ..', () => {
    expect(isPathInsideRoot(join(root, '..', 'outside', 'secret.txt'), root)).toBe(false);
    expect(isPathInsideRoot('../outside/secret.txt', root)).toBe(false);
  });

  it('rejects an unrelated absolute path', () => {
    expect(isPathInsideRoot(join(outside, 'secret.txt'), root)).toBe(false);
  });

  it('rejects a symlink that leaves the root', () => {
    if (!tryLink(outside, join(root, 'escape'), 'junction')) return;
    const through = join(root, 'escape', 'secret.txt');

    // The written path reads as contained. Only the resolved one is truthful.
    expect(through.startsWith(root)).toBe(true);
    expect(isPathInsideRoot(through, root)).toBe(false);
    expect(describeRealPath(through, root)).toContain('outside');
  });

  it('rejects a dangling symlink pointing outside', () => {
    // Writing through this link would create the file outside the root, so a
    // missing target must not make it look harmless.
    if (!tryLink(join(outside, 'not-yet.txt'), join(root, 'dangling'), 'file')) return;
    expect(isPathInsideRoot(join(root, 'dangling'), root)).toBe(false);
  });

  it('accepts a symlink that stays inside the root', () => {
    const nested = join(root, 'nested');
    mkdirSync(nested, { recursive: true });
    if (!tryLink(nested, join(root, 'inner-link'), 'junction')) return;
    expect(isPathInsideRoot(join(root, 'inner-link', 'file.txt'), root)).toBe(true);
  });

  it('resolves an ancestor that is itself reached through an absolute link', () => {
    // The arrangement macOS has out of the box: the temporary directory lives
    // under /var, which is a link to /private/var. A link inside the workspace
    // then points at the unresolved spelling of its own sibling. Following the
    // absolute target without re-resolving it from the top leaves one path
    // prefixed /var and the other /private/var, and a file plainly inside the
    // workspace is refused as foreign. It cost three red macOS jobs.
    const physical = join(base, 'physical');
    mkdirSync(join(physical, 'workspace', 'nested'), { recursive: true });
    if (!tryLink(physical, join(base, 'alias'), 'junction')) return;

    const aliasRoot = join(base, 'alias', 'workspace');
    if (!tryLink(join(aliasRoot, 'nested'), join(physical, 'workspace', 'inner'), 'junction')) return;

    expect(isPathInsideRoot(join(aliasRoot, 'inner', 'file.txt'), aliasRoot)).toBe(true);
    // The containment check must not have been loosened to get there.
    expect(isPathInsideRoot(join(base, 'outside', 'secret.txt'), aliasRoot)).toBe(false);
  });

  it('resolves relative paths against the root, not the process cwd', () => {
    expect(resolveSafePath('sub/file.txt', root)).toBe(join(root, 'sub', 'file.txt'));
  });
});
