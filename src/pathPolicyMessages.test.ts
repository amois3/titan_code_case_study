import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join, resolve } from 'path';
import {
  describeRealPath,
  ensureDirectory,
  ensurePathExists,
  expandUserPath,
  formatPathOutsideRootMessage,
  isPathInsideRoot,
  normalizeUserPath,
  setProjectRoot,
  toDisplayHomePath
} from './pathPolicy';

/**
 * The refusal a blocked path produces, and the repairs that stop a path from
 * being blocked for the wrong reason. Both are written for the model, which is
 * the reader that has to act on them.
 */
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'titan-code-paths-'));
  setProjectRoot(root);
});

afterEach(() => {
  setProjectRoot(process.cwd());
  rmSync(root, { recursive: true, force: true });
});

describe('what a refusal says', () => {
  it('names the path, the workspace, and who can move it', () => {
    const message = formatPathOutsideRootMessage('/etc/passwd', root);

    expect(message).toContain('outside the workspace');
    expect(message).toContain(resolve(root));
    // Addressed to the reader that cannot run /cd itself.
    expect(message).toContain('cannot change the workspace root yourself');
    expect(message).toContain('/cd');
  });

  it('tells the model not to try another spelling of the same path', () => {
    // Without this the refusal reads as an argument problem, and the next turn
    // is spent rewriting the path.
    expect(formatPathOutsideRootMessage('../../etc', root)).toContain('Do not retry');
  });

  it('names the link when the path only looks contained', () => {
    // Otherwise the refusal reads as a false positive: the path plainly starts
    // with the workspace.
    const outside = mkdtempSync(join(tmpdir(), 'titan-code-outside-'));
    const link = join(root, 'shortcut');
    try {
      symlinkSync(outside, link, 'junction');
    } catch {
      return; // symlinks need a privilege this machine may not grant
    }

    const message = formatPathOutsideRootMessage(link, root);
    expect(message).toContain('resolves through a symlink to');
    rmSync(outside, { recursive: true, force: true });
  });

  it('says nothing about a link when there is not one', () => {
    expect(formatPathOutsideRootMessage('/etc/passwd', root)).not.toContain('symlink');
  });
});

describe('following a link before deciding', () => {
  it('refuses a file reached through a link that leaves the workspace', () => {
    const outside = mkdtempSync(join(tmpdir(), 'titan-code-outside-'));
    writeFileSync(join(outside, 'secret.txt'), 'not yours', 'utf-8');
    const link = join(root, 'shortcut');
    try {
      symlinkSync(outside, link, 'junction');
    } catch {
      return;
    }

    expect(isPathInsideRoot(join(link, 'secret.txt'))).toBe(false);
    rmSync(outside, { recursive: true, force: true });
  });

  it('allows a link that stays inside', () => {
    mkdirSync(join(root, 'real'));
    writeFileSync(join(root, 'real', 'file.txt'), 'mine', 'utf-8');
    try {
      symlinkSync(join(root, 'real'), join(root, 'alias'), 'junction');
    } catch {
      return;
    }

    expect(isPathInsideRoot(join(root, 'alias', 'file.txt'))).toBe(true);
  });

  it('says where a path actually points', () => {
    writeFileSync(join(root, 'plain.txt'), 'x', 'utf-8');
    expect(describeRealPath(join(root, 'plain.txt'))).toContain('plain.txt');
  });

  it('has an answer for a path that does not exist', () => {
    // A write names a file that is not there yet; it still has to be judged.
    expect(isPathInsideRoot(join(root, 'not-yet.txt'))).toBe(true);
    expect(isPathInsideRoot(join(tmpdir(), 'elsewhere', 'not-yet.txt'))).toBe(false);
  });

  it('treats the workspace itself as inside it', () => {
    expect(isPathInsideRoot(root)).toBe(true);
    expect(isPathInsideRoot('.')).toBe(true);
  });
});

describe('paths people and models write', () => {
  it('expands a leading tilde, in either slash', () => {
    expect(expandUserPath('~')).toBe(homedir());
    expect(expandUserPath('~/Desktop')).toBe(join(homedir(), 'Desktop'));
    expect(expandUserPath('~\\Desktop')).toBe(join(homedir(), 'Desktop'));
  });

  it('leaves a path with no tilde alone', () => {
    expect(expandUserPath('/usr/local')).toBe('/usr/local');
    expect(expandUserPath('')).toBe('');
  });

  it('repairs a tilde that has already been resolved into a path', () => {
    // `resolve(workspace, "~\\Desktop")` produces C:\…\workspace\~\Desktop —
    // a directory that does not exist and that the agent then reports as empty.
    const damaged = join(root, '~', 'Desktop');
    expect(normalizeUserPath(damaged)).toBe(join(homedir(), 'Desktop'));
  });

  it('shortens a path under the home directory for display', () => {
    expect(toDisplayHomePath(homedir())).toBe('~');
    expect(toDisplayHomePath(join(homedir(), 'projects'))).toContain('~');
  });

  it('leaves a path outside the home directory in full', () => {
    const outside = process.platform === 'win32' ? 'C:\\Windows' : '/usr/local';
    expect(toDisplayHomePath(outside)).toBe(resolve(outside));
  });
});

describe('asking about a path', () => {
  it('says whether something is there', () => {
    writeFileSync(join(root, 'here.txt'), 'x', 'utf-8');

    expect(ensurePathExists(join(root, 'here.txt'))).toBe(true);
    expect(ensurePathExists(join(root, 'nowhere.txt'))).toBe(false);
  });

  it('says whether it is a directory, without throwing when it is nothing', () => {
    mkdirSync(join(root, 'folder'));
    writeFileSync(join(root, 'file.txt'), 'x', 'utf-8');

    expect(ensureDirectory(join(root, 'folder'))).toBe(true);
    expect(ensureDirectory(join(root, 'file.txt'))).toBe(false);
    expect(ensureDirectory(join(root, 'nothing'))).toBe(false);
  });
});
