import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { checkWorkspaceDestruction, classifyDestructive } from './workspaceGuard';

/**
 * The dangerous-command patterns guard the machine and the path policy guards
 * everything outside the workspace. Inside it there was nothing: git reset
 * --hard, git clean -fd and rm -rf src all ran on one keypress, and what they
 * take is the only work with no copy anywhere. A committed file comes back and
 * a pushed branch is safe; an afternoon of uncommitted editing does not.
 *
 * Run against real repositories, because the question the guard asks - what
 * would actually be lost - is answered by git, and a mocked answer would test
 * the mock.
 */
let repo: string;

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'titan-wsguard-'));
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  writeFileSync(join(repo, 'app.ts'), 'const a = 1;\n', 'utf-8');
  git('add', '.');
  git('commit', '-q', '-m', 'initial');
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('recognising what a command would take', () => {
  it('spots the commands that discard tracked work', () => {
    expect(classifyDestructive('git reset --hard HEAD~1')?.kind).toBe('discard-tracked');
    expect(classifyDestructive('git checkout -- src/app.ts')?.kind).toBe('discard-tracked');
    expect(classifyDestructive('git checkout .')?.kind).toBe('discard-tracked');
    expect(classifyDestructive('git restore src')?.kind).toBe('discard-tracked');
    expect(classifyDestructive('git stash clear')?.kind).toBe('discard-tracked');
  });

  it('spots the commands that delete files git has no copy of', () => {
    expect(classifyDestructive('git clean -fd')?.kind).toBe('delete-untracked');
    expect(classifyDestructive('rm -rf build')?.kind).toBe('delete-path');
    expect(classifyDestructive('rm -r src')?.kind).toBe('delete-path');
    expect(classifyDestructive('find . -name "*.ts" -delete')?.kind).toBe('delete-path');
  });

  it('leaves alone the commands that take nothing', () => {
    // Switching branches, staging, inspecting - none of these discard a tree.
    for (const command of [
      'git status',
      'git checkout main',
      'git checkout -b feature',
      'git restore --staged src',
      'git reset --soft HEAD~1',
      'git stash',
      'git clean -n',
      'npm test',
      'rm single-file.txt',
      'ls -la'
    ]) {
      expect(classifyDestructive(command)).toBeNull();
    }
  });

  it('sees through a chain', () => {
    // The dangerous half of `npm test && git reset --hard` is still dangerous.
    expect(classifyDestructive('npm test && git reset --hard')?.kind).toBe('discard-tracked');
  });
});

describe('against a clean tree', () => {
  it('allows the tidying commands that a name-based ban would break', () => {
    // This is the case that makes refusing by name wrong: after a successful
    // merge or build, these are routine and cost nothing.
    for (const command of ['git reset --hard', 'git clean -fd', 'git restore .', 'rm -rf build']) {
      expect(checkWorkspaceDestruction(command, repo).allowed).toBe(true);
    }
  });
});

describe('against work that exists nowhere else', () => {
  it('refuses to discard uncommitted changes, and says what they are', () => {
    writeFileSync(join(repo, 'app.ts'), 'const a = 2; // an hour of work\n', 'utf-8');

    const verdict = checkWorkspaceDestruction('git reset --hard', repo);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain('1 file with uncommitted changes');
    expect(verdict.reason).toContain('app.ts');
    // The way out is named, so the agent is not left guessing.
    expect(verdict.reason).toContain('Commit or stash');
  });

  it('refuses git clean while untracked files exist', () => {
    writeFileSync(join(repo, 'notes.md'), 'not committed anywhere\n', 'utf-8');

    const verdict = checkWorkspaceDestruction('git clean -fd', repo);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain('untracked file');
    expect(verdict.reason).toContain('notes.md');
  });

  it('does not confuse the two kinds of loss', () => {
    // A modified tracked file is not at risk from git clean, and an untracked
    // file is not at risk from git reset --hard.
    writeFileSync(join(repo, 'app.ts'), 'modified\n', 'utf-8');
    expect(checkWorkspaceDestruction('git clean -fd', repo).allowed).toBe(true);

    git('checkout', '--', 'app.ts');
    writeFileSync(join(repo, 'stray.txt'), 'untracked\n', 'utf-8');
    expect(checkWorkspaceDestruction('git reset --hard', repo).allowed).toBe(true);
  });

  it('counts both when the command deletes a path outright', () => {
    writeFileSync(join(repo, 'app.ts'), 'modified\n', 'utf-8');
    writeFileSync(join(repo, 'stray.txt'), 'untracked\n', 'utf-8');

    const verdict = checkWorkspaceDestruction('rm -rf .', repo);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain('2 uncommitted and untracked files');
  });

  it('writes the count as a person would', () => {
    // Appending an s to "file with uncommitted changes" gives "changess",
    // which is what it did.
    writeFileSync(join(repo, 'app.ts'), 'one\n', 'utf-8');
    writeFileSync(join(repo, 'second.ts'), 'two\n', 'utf-8');
    git('add', 'second.ts');

    const many = checkWorkspaceDestruction('git reset --hard', repo).reason ?? '';
    expect(many).toContain('2 files with uncommitted changes would be lost');
    expect(many).not.toMatch(/changess|filess/);

    git('checkout', '--', 'app.ts');
    git('reset', '-q');
    rmSync(join(repo, 'second.ts'), { force: true });
    writeFileSync(join(repo, 'app.ts'), 'only one\n', 'utf-8');
    const one = checkWorkspaceDestruction('git reset --hard', repo).reason ?? '';
    expect(one).toContain('1 file with uncommitted changes would be lost');
    expect(one).toContain('no copy of it');
  });
});

describe('spellings that used to walk straight past it', () => {
  // The first version of this guard read word one of each segment by hand and
  // caught exactly one of these. The parser next door already saw through all
  // of them; not reusing it was the mistake.
  it('sees through git global options', () => {
    expect(classifyDestructive('git -C . reset --hard')?.kind).toBe('discard-tracked');
    expect(classifyDestructive('git --git-dir=.git reset --hard')?.kind).toBe('discard-tracked');
  });

  it('sees into an inline script', () => {
    expect(classifyDestructive('bash -c "git reset --hard"')?.kind).toBe('discard-tracked');
    expect(classifyDestructive('sh -c "rm -rf src"')?.kind).toBe('delete-path');
  });

  it('sees through wrappers and full paths', () => {
    expect(classifyDestructive('env git reset --hard')?.kind).toBe('discard-tracked');
    expect(classifyDestructive('/usr/bin/git reset --hard')?.kind).toBe('discard-tracked');
    expect(classifyDestructive('echo . | xargs rm -rf')?.kind).toBe('delete-path');
  });

  it('counts emptying a file as destroying it', () => {
    expect(classifyDestructive('> src/main.ts')?.kind).toBe('delete-path');
    expect(classifyDestructive('cat /dev/null > src/main.ts')?.kind).toBe('delete-path');
    expect(classifyDestructive('truncate -s 0 src/main.ts')?.kind).toBe('delete-path');
    expect(classifyDestructive('sed -i "s/.*//" src/main.ts')?.kind).toBe('delete-path');
  });

  it('leaves appends and device writes alone', () => {
    expect(classifyDestructive('npm test >> build.log')).toBeNull();
    expect(classifyDestructive('npm test 2>/dev/null')).toBeNull();
  });
});

describe('not getting in the way', () => {
  // A guard that refuses ordinary work is a guard that gets switched off, and
  // one that is switched off protects nothing. These are the cases that decide
  // whether it survives contact with a real branch.
  beforeEach(() => {
    writeFileSync(join(repo, 'app.ts'), 'work in progress\n', 'utf-8');
    writeFileSync(join(repo, 'scratch.txt'), 'untracked\n', 'utf-8');
  });

  it('allows writing a new file while the branch is dirty elsewhere', () => {
    expect(checkWorkspaceDestruction('echo hello > notes.md', repo).allowed).toBe(true);
  });

  it('allows deleting a directory that holds nothing unsaved', () => {
    expect(checkWorkspaceDestruction('rm -rf build', repo).allowed).toBe(true);
  });

  it('allows renaming, which keeps the contents', () => {
    expect(checkWorkspaceDestruction('mv app.ts renamed.ts', repo).allowed).toBe(true);
  });

  it('still refuses when the target is the file with the work in it', () => {
    const verdict = checkWorkspaceDestruction('> app.ts', repo);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain('app.ts');
  });

  it('does not count the CLI\'s own edit backups as work at risk', () => {
    // write_file and edit_file drop a .titan-backup beside every file they
    // touch, and nothing ever removes them. They are untracked, so without an
    // exemption `git clean` would be refused on the strength of litter this
    // tool dropped itself — after a few edits, permanently.
    writeFileSync(join(repo, 'app.ts.titan-backup'), 'previous contents\n', 'utf-8');
    rmSync(join(repo, 'scratch.txt'), { force: true });
    git('checkout', '--', 'app.ts');

    expect(checkWorkspaceDestruction('git clean -fd', repo).allowed).toBe(true);
  });

  it('still refuses a delete that reaches the unsaved work', () => {
    expect(checkWorkspaceDestruction('rm -rf .', repo).allowed).toBe(false);
    expect(checkWorkspaceDestruction('rm -rf app.ts scratch.txt', repo).allowed).toBe(false);
  });
});

describe('outside a repository', () => {
  let plain: string;

  beforeEach(() => {
    plain = mkdtempSync(join(tmpdir(), 'titan-wsguard-plain-'));
    writeFileSync(join(plain, 'thing.txt'), 'no version control here\n', 'utf-8');
  });

  afterEach(() => {
    rmSync(plain, { recursive: true, force: true });
  });

  it('refuses a recursive delete, because nothing there can be undone', () => {
    const verdict = checkWorkspaceDestruction('rm -rf .', plain);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain('not a git repository');
  });

  it('lets git commands through, since there is no repository to harm', () => {
    expect(checkWorkspaceDestruction('git reset --hard', plain).allowed).toBe(true);
  });

  it('allows creating a file by redirection', () => {
    // A truncating write to a path that does not exist destroys nothing. This
    // was refused outright — the most ordinary thing a shell does, blocked
    // with a message about deletion being unrecoverable.
    expect(checkWorkspaceDestruction('echo hello > new.txt', plain).allowed).toBe(true);
  });

  it('still refuses to empty a file that is there', () => {
    const verdict = checkWorkspaceDestruction('> thing.txt', plain);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain('not a git repository');
  });

  it('allows deleting what is not there', () => {
    expect(checkWorkspaceDestruction('rm -rf never-existed', plain).allowed).toBe(true);
  });

  it('refuses a pattern, which names no path but reaches every one', () => {
    expect(checkWorkspaceDestruction('rm -rf *', plain).allowed).toBe(false);
    expect(checkWorkspaceDestruction('rm -rf ./*.txt', plain).allowed).toBe(false);
  });
});

describe('a script that is not shell', () => {
  it('does not read a JavaScript arrow as a redirection', () => {
    // `node -e "setTimeout(() => {}, 30000)"` parsed as shell redirects into a
    // file called `{},`, and every `node -e` was refused as a deletion.
    expect(classifyDestructive('node -e "setTimeout(() => {}, 30000)"')).toBeNull();
    expect(classifyDestructive('python3 -c "print(1 if a > b else 2)"')).toBeNull();
  });

  it('still reads a shell script handed to a shell', () => {
    expect(classifyDestructive('bash -c "rm -rf src"')?.kind).toBe('delete-path');
  });
});
