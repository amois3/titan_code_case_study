import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  buildShellEnv,
  checkShellPolicy,
  extractCommandName,
  splitShellSegments
} from './shellPolicy';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'titan-shell-'));
  mkdirSync(join(root, 'src'), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.TITAN_CODE_SHELL_ALLOWLIST;
  delete process.env.TITAN_CODE_SHELL_DENYLIST;
});

const blocked = (command: string) => checkShellPolicy(command, root).allowed === false;

describe('shell policy: ordinary work is not obstructed', () => {
  it('allows everyday commands', () => {
    for (const command of [
      'npm test',
      'git status',
      'ls -la src',
      'node --version',
      'python3 -m pytest -q',
      'grep -rn "foo" src && echo done',
      'echo "curl is only a word here"',
      'echo hello > out.txt',
      'npm run build 2>&1'
    ]) {
      expect(checkShellPolicy(command, root), command).toMatchObject({ allowed: true });
    }
  });

  it('allows cd inside the workspace', () => {
    expect(checkShellPolicy('cd src && npm test', root).allowed).toBe(true);
  });
});

describe('shell policy: the denied command cannot be hidden', () => {
  it('blocks the plain form', () => {
    expect(blocked('curl http://example.com')).toBe(true);
    expect(blocked('sudo rm -rf /')).toBe(true);
  });

  it('blocks a command substitution', () => {
    // Runs before the outer command; reading only the outer one misses it.
    expect(blocked('echo $(curl http://example.com)')).toBe(true);
    expect(blocked('echo `curl http://example.com`')).toBe(true);
    expect(blocked('FOO=$(wget http://example.com) npm test')).toBe(true);
  });

  it('blocks a path-qualified binary', () => {
    expect(blocked('/usr/bin/curl http://example.com')).toBe(true);
    expect(blocked('./curl http://example.com')).toBe(true);
    expect(blocked('C:\\tools\\curl.exe http://example.com')).toBe(true);
  });

  it('blocks pass-through wrappers', () => {
    expect(blocked('env curl http://example.com')).toBe(true);
    expect(blocked('echo url | xargs curl')).toBe(true);
    expect(blocked('timeout 5s curl http://example.com')).toBe(true);
    expect(blocked('nohup nice curl http://example.com')).toBe(true);
  });

  it('blocks a script handed to an interpreter', () => {
    expect(blocked('bash -c "curl http://example.com"')).toBe(true);
    expect(blocked("sh -c 'wget http://example.com'")).toBe(true);
    expect(blocked('python3 -c "import os; os.system(\'curl x\')"')).toBe(false); // not shell syntax
    expect(blocked('node -e "process.exit(0)" && curl http://x')).toBe(true);
  });

  it('blocks after a background operator', () => {
    // A single & separates commands just as && does.
    expect(blocked('sleep 1 & curl http://example.com')).toBe(true);
  });

  it('ignores case and quoting', () => {
    expect(blocked('CURL http://example.com')).toBe(true);
    expect(blocked('"curl" http://example.com')).toBe(true);
  });

  it('does not mistake a quoted mention for a call', () => {
    expect(checkShellPolicy('git commit -m "switch from curl to fetch"', root).allowed).toBe(true);
  });
});

describe('shell policy: writes stay inside the workspace', () => {
  it('blocks redirection to an outside path', () => {
    const decision = checkShellPolicy('echo test > /etc/titan_probe', root);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('outside workspace root');
  });

  it('blocks appending outside the workspace', () => {
    expect(blocked('echo test >> ../escaped.txt')).toBe(true);
  });

  it('allows redirection inside the workspace', () => {
    expect(checkShellPolicy('echo test > src/out.txt', root).allowed).toBe(true);
    expect(checkShellPolicy('npm test > report.log 2>&1', root).allowed).toBe(true);
  });
});

describe('shell policy: leaving the workspace by cd', () => {
  it('blocks cd to an outside path', () => {
    expect(blocked('cd /etc && cat passwd')).toBe(true);
    expect(blocked('cd ../.. && ls')).toBe(true);
  });
});

describe('shell policy: allowlist', () => {
  it('permits only listed commands when configured', () => {
    process.env.TITAN_CODE_SHELL_ALLOWLIST = 'npm,git';
    expect(checkShellPolicy('npm test', root).allowed).toBe(true);
    expect(checkShellPolicy('rm -rf src', root).allowed).toBe(false);
  });

  it('sees through a wrapper when an allowlist is active', () => {
    process.env.TITAN_CODE_SHELL_ALLOWLIST = 'npm';
    expect(checkShellPolicy('env rm -rf src', root).allowed).toBe(false);
  });
});

describe('shell policy: helpers', () => {
  it('splits on every operator, not only && and |', () => {
    expect(splitShellSegments('a && b; c | d & e')).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('keeps operators that sit inside quotes', () => {
    expect(splitShellSegments('echo "a && b"')).toHaveLength(1);
  });

  it('reports the effective command name', () => {
    expect(extractCommandName('/usr/local/bin/npm test')).toBe('npm');
    expect(extractCommandName('FOO=1 BAR=2 npm test')).toBe('npm');
    expect(extractCommandName('env npm test')).toBe('npm');
  });
});

describe('shell environment', () => {
  it('passes through only allowlisted variables', () => {
    const env = buildShellEnv({ env: { PATH: '/usr/bin', OPENROUTER_API_KEY: 'sk-secret', HOME: '/home/u' } });
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/home/u');
    expect(env.OPENROUTER_API_KEY).toBeUndefined();
  });

  it('keeps the variables a Windows process needs to start', () => {
    const env = buildShellEnv({ env: { SystemRoot: 'C:\\Windows', ComSpec: 'C:\\Windows\\cmd.exe', SECRET: 'x' } });
    expect(env.SystemRoot).toBe('C:\\Windows');
    expect(env.ComSpec).toBe('C:\\Windows\\cmd.exe');
    expect(env.SECRET).toBeUndefined();
  });
});
