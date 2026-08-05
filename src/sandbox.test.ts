import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join, resolve as resolvePath } from 'path';
import {
  defaultPolicy,
  detectSandbox,
  networkAllowed,
  planSandbox,
  resetSandboxCache,
  sandboxStatus
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

describe('sandbox invocation', () => {
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
