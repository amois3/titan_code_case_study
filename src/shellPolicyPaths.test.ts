import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import {
  buildShellEnv,
  checkShellPolicy,
  detectCwdEscape,
  extractCommandName,
  getShellAllowlist,
  getShellDenylist,
  splitShellSegments
} from './shellPolicy';

/**
 * The policy reads a command rather than pattern-matching it, which is the
 * only way to see through `env`, `sudo`, `timeout`, a subshell and an inline
 * script. What it must not do is refuse ordinary work, or let a write out of
 * the workspace through a spelling nobody enumerated.
 */
let workspace: string;
const envBackup = new Map<string, string | undefined>();

function setEnv(key: string, value: string | undefined): void {
  if (!envBackup.has(key)) envBackup.set(key, process.env[key]);
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

afterEach(() => {
  for (const [key, value] of envBackup.entries()) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  envBackup.clear();
  if (workspace) {
    rmSync(workspace, { recursive: true, force: true });
    workspace = '';
  }
});

function root(): string {
  workspace = mkdtempSync(join(tmpdir(), 'titan-code-policy-'));
  return resolve(workspace);
}

describe('naming the program that will actually run', () => {
  it('sees through the wrappers a command is written with', () => {
    expect(extractCommandName('env npm test')).toBe('npm');
    expect(extractCommandName('FOO=1 BAR=2 npm test')).toBe('npm');
    expect(extractCommandName('timeout 5s npm test')).toBe('npm');
    expect(extractCommandName('nice -n 10 npm test')).toBe('npm');
  });

  it('has nothing to name for an empty command', () => {
    expect(extractCommandName('')).toBe('');
    expect(extractCommandName('   ')).toBe('');
  });

  it('takes the path off an absolute program name', () => {
    expect(extractCommandName('/usr/local/bin/npm test')).toBe('npm');
  });
});

describe('splitting a command line', () => {
  it('separates what the shell would run separately', () => {
    expect(splitShellSegments('npm run build && npm test').length).toBeGreaterThan(1);
    expect(splitShellSegments('a; b; c').length).toBe(3);
  });

  it('does not split inside quotes, where the separator is text', () => {
    expect(splitShellSegments('echo "a && b"')).toHaveLength(1);
  });
});

describe('leaving the workspace', () => {
  it('refuses a bare cd, which would leave it', () => {
    const cwd = root();
    const refusal = detectCwdEscape('cd', cwd);

    expect(refusal).toContain('bare cd');
    expect(refusal).toContain(cwd);
  });

  it('refuses cd - for the same reason', () => {
    const cwd = root();
    expect(detectCwdEscape('cd -', cwd)).toContain('bare cd');
  });

  it('allows moving about inside the workspace', () => {
    const cwd = root();
    expect(detectCwdEscape('cd src', cwd)).toBeNull();
    expect(detectCwdEscape('cd ./src/lib', cwd)).toBeNull();
  });

  it('refuses a relative path that climbs out', () => {
    const cwd = root();
    const refusal = detectCwdEscape('cd ../..', cwd);

    expect(refusal).toContain('workspace');
    // And says what to do about it rather than only refusing.
    expect(refusal).toContain('/cd');
  });

  it('refuses an absolute path outside, and a home-relative one', () => {
    const cwd = root();
    expect(detectCwdEscape('cd /etc', cwd)).toContain('workspace');
    setEnv('HOME', '/home/someone');
    expect(detectCwdEscape('cd ~/Desktop', cwd)).toContain('workspace');
  });

  it('checks pushd as well, which moves just the same', () => {
    const cwd = root();
    expect(detectCwdEscape('pushd /etc', cwd)).toContain('workspace');
  });

  it('has no opinion about a command that does not move', () => {
    const cwd = root();
    expect(detectCwdEscape('npm test', cwd)).toBeNull();
  });
});

describe('what the policy allows', () => {
  it('lets ordinary work through', () => {
    const cwd = root();
    for (const command of ['npm test', 'git status', 'node --version', 'ls -la', 'cat package.json']) {
      expect(checkShellPolicy(command, cwd).allowed, command).toBe(true);
    }
  });

  it('refuses the commands denied by default, and says who can lift it', () => {
    const cwd = root();
    const refusal = checkShellPolicy('sudo apt install anything', cwd);

    expect(refusal.allowed).toBe(false);
    expect(refusal.commandName).toBe('sudo');
    expect(refusal.suggestion).toContain('non-root');
  });

  it('points at the tool that replaces the command it refused', () => {
    const cwd = root();
    expect(checkShellPolicy('curl https://example.invalid', cwd).suggestion).toContain('fetch(');
  });

  it('sees a denied command through a wrapper', () => {
    const cwd = root();
    expect(checkShellPolicy('env sudo rm -rf /', cwd).allowed).toBe(false);
    expect(checkShellPolicy('timeout 5 curl https://example.invalid', cwd).allowed).toBe(false);
  });

  it('sees a denied command in the second half of a chain', () => {
    const cwd = root();
    expect(checkShellPolicy('npm test && curl https://example.invalid', cwd).allowed).toBe(false);
  });

  it('reads the script handed to an interpreter, not just the interpreter', () => {
    // `sh -c "curl …"` is a denied command with a permitted one in front of it.
    const cwd = root();
    expect(checkShellPolicy('sh -c "curl https://example.invalid"', cwd).allowed).toBe(false);
    expect(checkShellPolicy('bash -c "npm test"', cwd).allowed).toBe(true);
  });

  it('reads a command substitution as a command', () => {
    const cwd = root();
    expect(checkShellPolicy('echo $(curl https://example.invalid)', cwd).allowed).toBe(false);
  });
});

describe('the lists an installation configures', () => {
  it('has a denylist by default and no allowlist', () => {
    setEnv('TITAN_CODE_SHELL_ALLOWLIST', undefined);
    setEnv('TITAN_CODE_SHELL_DENYLIST', undefined);

    expect(getShellAllowlist()).toEqual([]);
    expect(getShellDenylist()).toContain('sudo');
  });

  it('adds what the operator configured to what is denied by default', () => {
    setEnv('TITAN_CODE_SHELL_DENYLIST', 'kubectl, TERRAFORM');

    const denied = getShellDenylist();
    expect(denied).toContain('kubectl');
    expect(denied).toContain('terraform');
    expect(denied).toContain('sudo');
  });

  it('lets an allowlisted command through the default denial', () => {
    const cwd = root();
    expect(checkShellPolicy('curl https://example.invalid', cwd).allowed).toBe(false);

    setEnv('TITAN_CODE_SHELL_ALLOWLIST', 'curl');
    expect(checkShellPolicy('curl https://example.invalid', cwd).allowed).toBe(true);
  });

  it('does not let an allowlist override what the operator denied on purpose', () => {
    const cwd = root();
    setEnv('TITAN_CODE_SHELL_DENYLIST', 'kubectl');
    setEnv('TITAN_CODE_SHELL_ALLOWLIST', 'kubectl');

    expect(checkShellPolicy('kubectl delete everything', cwd).allowed).toBe(false);
  });
});

describe('the environment a command is given', () => {
  it('passes on what a build needs and nothing else', () => {
    // An allowlist rather than the process environment: a shell command the
    // model wrote should not be handed every key the operator has exported.
    const env = buildShellEnv({ env: { PATH: '/usr/bin', HOME: '/home/dev', OPENROUTER_API_KEY: 'sk-secret' } });

    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/home/dev');
    expect(env.OPENROUTER_API_KEY).toBeUndefined();
  });

  it('lets an installation add to that list on purpose', () => {
    const env = buildShellEnv({
      env: { TITAN_CODE_SHELL_ENV_ALLOWLIST: 'MY_TOKEN', MY_TOKEN: 'value', OTHER: 'dropped' }
    });

    expect(env.MY_TOKEN).toBe('value');
    expect(env.OTHER).toBeUndefined();
  });

  it('keeps the shell from paging, which would hang the call', () => {
    // A pager waiting for a keypress in a tool call is a hang with nothing on
    // screen to explain it.
    const env = buildShellEnv({ env: {} });
    expect(env.PAGER).toBe('cat');
    expect(env.LESS).toBe('FRX');
  });
});
