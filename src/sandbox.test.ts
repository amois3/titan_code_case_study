import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join, resolve as resolvePath } from 'path';
import {
  bubblewrapArgs,
  defaultPolicy,
  detectSandbox,
  networkAllowed,
  planSandbox,
  resetSandboxCache,
  sandboxStatus,
  seatbeltProfile,
  type SandboxPolicy
} from './sandbox';

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
  resetSandboxCache();
});

describe('sandbox policy', () => {
  it('makes the workspace writable and adds the temp directory', () => {
    const policy = defaultPolicy('/some/workspace');
    expect(policy.writableRoots[0]).toContain('workspace');
    // Toolchains write to temp as a matter of course; without it even tsc fails.
    // Compare realpath: macOS tmpdir is often /var/... while the kernel sees /private/var/...
    const temp = resolvePath(tmpdir());
    const realTemp = existsSync(temp) ? realpathSync(temp) : temp;
    expect(
      policy.writableRoots.some((root) => root === temp || root === realTemp)
    ).toBe(true);
  });

  it('allows the network unless explicitly switched off', () => {
    setEnv('TITAN_CODE_SANDBOX_NETWORK', undefined);
    expect(networkAllowed()).toBe(true);
    setEnv('TITAN_CODE_SANDBOX_NETWORK', 'off');
    expect(networkAllowed()).toBe(false);
  });

  it('can be turned off deliberately, and says so', () => {
    setEnv('TITAN_CODE_SANDBOX', 'off');
    resetSandboxCache();
    const status = sandboxStatus();
    expect(status.backend).toBe('none');
    expect(status.detail).toContain('TITAN_CODE_SANDBOX=off');
  });

  it('never claims confinement it does not have', () => {
    resetSandboxCache();
    const { backend } = detectSandbox();
    const status = sandboxStatus();
    if (backend === 'none') {
      // The reason has to be stated: silence here would read as protection.
      expect(status.detail.length).toBeGreaterThan(0);
      expect(status.label).toContain('none');
    } else {
      expect(status.label).toContain(backend);
    }
  });
});

/**
 * The policy itself, asserted on every platform.
 *
 * These arguments and this profile are the sandbox — everything else in the
 * module picks a backend or reports on one. They used to be unexported, so the
 * only way to reach them was to run on a host with a working backend, and on
 * every other machine the security-defining code was executed by nothing at
 * all. That, rather than any shortage of care, is why this module sat at a
 * third the coverage of its neighbours: the end-to-end test below is thorough
 * and simply cannot run on Windows.
 */
describe('the policy handed to bubblewrap', () => {
  const policy = (overrides: Partial<SandboxPolicy> = {}): SandboxPolicy => ({
    writableRoots: [resolvePath(tmpdir())],
    allowNetwork: true,
    ...overrides
  });

  it('mounts the whole filesystem read-only', () => {
    const args = bubblewrapArgs(policy(), tmpdir());
    const index = args.indexOf('--ro-bind');
    expect(index).toBeGreaterThanOrEqual(0);
    expect(args.slice(index, index + 3)).toEqual(['--ro-bind', '/', '/']);
  });

  it('binds each writable root back in, and nothing else', () => {
    const args = bubblewrapArgs(policy(), tmpdir());
    const bound: string[] = [];
    for (let i = 0; i < args.length - 2; i++) {
      if (args[i] === '--bind') bound.push(args[i + 1]!);
    }
    expect(bound).toHaveLength(1);
    expect(bound[0]).toBe(realpathSync(resolvePath(tmpdir())));
  });

  it('gives the command its own process namespace', () => {
    // Without it a command confined to the workspace can still signal any
    // process the user owns, which is not the boundary this draws.
    expect(bubblewrapArgs(policy(), tmpdir())).toContain('--unshare-pid');
  });

  it('does not outlive the session that started it', () => {
    const args = bubblewrapArgs(policy(), tmpdir());
    expect(args).toContain('--die-with-parent');
    // A new session keeps the confined process off the controlling terminal.
    expect(args).toContain('--new-session');
  });

  it('cuts the network only when asked', () => {
    expect(bubblewrapArgs(policy({ allowNetwork: true }), tmpdir())).not.toContain('--unshare-net');
    expect(bubblewrapArgs(policy({ allowNetwork: false }), tmpdir())).toContain('--unshare-net');
  });

  it('leaves the wrapped command last, after the -- separator', () => {
    const args = bubblewrapArgs(policy(), tmpdir());
    expect(args.at(-1)).toBe('--');
  });

  it('skips a writable root that does not exist rather than failing the mount', () => {
    const args = bubblewrapArgs(policy({ writableRoots: [join(tmpdir(), 'definitely-not-here-xyz')] }), tmpdir());
    expect(args).not.toContain('--bind');
  });
});

describe('the profile handed to seatbelt', () => {
  const policy = (overrides: Partial<SandboxPolicy> = {}): SandboxPolicy => ({
    writableRoots: [resolvePath(tmpdir())],
    allowNetwork: true,
    ...overrides
  });

  it('denies writes and allows reads', () => {
    const profile = seatbeltProfile(policy());
    // Order matters in Seatbelt: the later rule wins, so the blanket deny must
    // precede the per-root allowances.
    expect(profile.indexOf('(deny file-write*)')).toBeGreaterThan(profile.indexOf('(allow default)'));
    expect(profile.indexOf('(allow file-write* (subpath')).toBeGreaterThan(profile.indexOf('(deny file-write*)'));
    expect(profile).toContain('(allow file-read*)');
  });

  it('allows writing to each root', () => {
    const profile = seatbeltProfile(policy());
    expect(profile).toContain(`(allow file-write* (subpath ${JSON.stringify(realpathSync(resolvePath(tmpdir())))}))`);
  });

  it('keeps ordinary output working', () => {
    // Denying the null and terminal devices breaks every command that prints.
    const profile = seatbeltProfile(policy());
    for (const device of ['/dev/null', '/dev/stdout', '/dev/stderr', '/dev/tty']) {
      expect(profile).toContain(`(literal "${device}")`);
    }
  });

  it('cuts the network only when asked', () => {
    expect(seatbeltProfile(policy({ allowNetwork: true }))).not.toContain('(deny network*)');
    expect(seatbeltProfile(policy({ allowNetwork: false }))).toContain('(deny network*)');
  });

  it('quotes a path that would otherwise break the profile', () => {
    // A workspace under "My Documents", or one with a quote in its name, must
    // not be able to terminate the string and become profile syntax.
    const awkward = join(tmpdir(), 'a path "with quotes" and \\ backslash');
    const profile = seatbeltProfile(policy({ writableRoots: [awkward] }));
    const line = profile.split('\n').find((l) => l.includes('subpath'))!;
    expect(line).toBe(`(allow file-write* (subpath ${JSON.stringify(resolvePath(awkward))}))`);
    // One opening quote and one closing quote on that line, no more.
    expect((line.match(/(?<!\\)"/g) ?? []).length).toBe(2);
  });
});

describe('sandbox invocation', () => {
  it('refuses to confine a command to nothing', () => {
    // Every root gone — a deleted workspace, a vanished temp directory — is a
    // sandbox in which no write can succeed, for a reason no error explains.
    resetSandboxCache();
    const { backend } = detectSandbox();
    if (backend === 'none') return;

    const plan = planSandbox('/bin/sh', ['-c', 'true'], {
      writableRoots: [join(tmpdir(), 'gone-xyz-123')],
      allowNetwork: true
    }, tmpdir());
    expect(plan.backend).toBe('none');
    expect(plan.unavailableReason).toContain('refusing to confine to nothing');
  });

  it('leaves the command untouched when no backend exists', () => {
    setEnv('TITAN_CODE_SANDBOX', 'off');
    resetSandboxCache();
    const plan = planSandbox('/bin/sh', ['-c', 'echo hi'], defaultPolicy('/w'), '/w');
    expect(plan.command).toBe('/bin/sh');
    expect(plan.args).toEqual(['-c', 'echo hi']);
    expect(plan.unavailableReason).toBeTruthy();
  });

  it('wraps the shell when a backend exists', () => {
    resetSandboxCache();
    const { backend } = detectSandbox();
    if (backend === 'none') return;

    const plan = planSandbox('/bin/sh', ['-c', 'echo hi'], defaultPolicy('/w'), '/w');
    expect(plan.command).not.toBe('/bin/sh');
    // The original invocation survives intact at the end of the argument list.
    expect(plan.args.slice(-3)).toEqual(['/bin/sh', '-c', 'echo hi']);
  });
});

/**
 * The claim worth testing is not that a wrapper was assembled but that the
 * kernel actually refuses the write. These run only where a backend exists.
 *
 * Skipping is right on a developer's Windows machine and wrong in CI, where a
 * silently skipped security test looks exactly like a passing one. Setting
 * TITAN_CODE_REQUIRE_SANDBOX=1 — which the Linux and macOS jobs do — turns the
 * absence of a backend into a failure instead.
 */
function sandboxUnavailable(reason?: string): boolean {
  if (process.env.TITAN_CODE_REQUIRE_SANDBOX === '1') {
    throw new Error(
      `TITAN_CODE_REQUIRE_SANDBOX=1 but no sandbox backend is active: ${reason ?? 'no reason given'}`
    );
  }
  return true;
}

describe('sandbox containment, end to end', () => {
  it('permits writes inside the workspace and refuses them outside', () => {
    resetSandboxCache();
    const { backend, reason } = detectSandbox();
    if (backend === 'none' && sandboxUnavailable(reason)) return;

    // Workspace lives under tmpdir (also marked writable for toolchains).
    // The "outside" path must NOT sit under tmpdir — defaultPolicy allows the
    // whole temp tree, so a sibling under /tmp would still be writable.
    const base = mkdtempSync(join(tmpdir(), 'titan-sandbox-test-'));
    const workspace = join(base, 'workspace');
    const outside = mkdtempSync(join(homedir(), '.titan-sandbox-out-'));
    mkdirSync(workspace, { recursive: true });
    const guarded = join(outside, 'untouched.txt');
    writeFileSync(guarded, 'original');

    try {
      const policy = defaultPolicy(workspace);

      const inside = planSandbox('/bin/sh', ['-c', 'echo written > allowed.txt'], policy, workspace);
      execFileSync(inside.command, inside.args, { cwd: workspace, stdio: 'ignore' });
      expect(existsSync(join(workspace, 'allowed.txt'))).toBe(true);

      const escape = planSandbox('/bin/sh', ['-c', `echo tampered > ${guarded}`], policy, workspace);
      try {
        execFileSync(escape.command, escape.args, { cwd: workspace, stdio: 'ignore' });
      } catch {
        // A non-zero exit is the expected outcome.
      }
      expect(readFileSync(guarded, 'utf-8').trim()).toBe('original');
    } finally {
      rmSync(base, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
