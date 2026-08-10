import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Which confinement this host can actually offer, and what happens when the
 * answer is none.
 *
 * The decision is made once per process and everything that runs a command
 * depends on it. It is also the part of the sandbox that cannot be reached on
 * the machine this is developed on: the Linux and macOS branches never execute
 * on Windows, so the platform and the binaries are stood in for here. What is
 * under test is the decision — presence is not capability, a probe that fails
 * means no sandbox rather than a broken one — not the kernel underneath it.
 */
const spawned = vi.hoisted(() => ({
  calls: [] as Array<{ command: string; args: string[] }>,
  result: { status: 0, error: undefined as Error | undefined }
}));

const files = vi.hoisted(() => ({ executable: new Set<string>() }));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    spawnSync: (command: string, args: string[]) => {
      spawned.calls.push({ command, args });
      return spawned.result as ReturnType<typeof actual.spawnSync>;
    }
  };
});

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    accessSync: (path: string, mode?: number) => {
      // X_OK is the only thing the sandbox asks about; everything else is a
      // real file this test has no business intercepting.
      if (mode === actual.constants.X_OK) {
        if (!files.executable.has(String(path).replace(/\\/g, '/'))) {
          throw new Error(`EACCES: ${path}`);
        }
        return undefined;
      }
      return actual.accessSync(path, mode);
    }
  };
});

const originalPlatform = process.platform;
const envBackup = new Map<string, string | undefined>();

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

function setEnv(key: string, value: string | undefined): void {
  if (!envBackup.has(key)) envBackup.set(key, process.env[key]);
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function onPath(...paths: string[]): void {
  for (const path of paths) files.executable.add(path);
}

async function sandbox() {
  const module = await import('./sandbox.js');
  module.resetSandboxCache();
  return module;
}

beforeEach(() => {
  spawned.calls = [];
  spawned.result = { status: 0, error: undefined };
  files.executable = new Set();
  setEnv('PATH', '/usr/bin:/usr/local/bin');
  setEnv('TITAN_CODE_SANDBOX', undefined);
  setEnv('TITAN_CODE_SANDBOX_NETWORK', undefined);
  vi.resetModules();
});

afterEach(async () => {
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  for (const [key, value] of envBackup.entries()) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  envBackup.clear();
  const { resetSandboxCache } = await import('./sandbox.js');
  resetSandboxCache();
  vi.resetModules();
});

describe('on Linux', () => {
  beforeEach(() => setPlatform('linux'));

  it('uses bubblewrap when it is there and works', async () => {
    onPath('/usr/bin/bwrap');
    const { detectSandbox } = await sandbox();

    const detected = detectSandbox();
    expect(detected.backend).toBe('bubblewrap');
    // Joined with this host's separator, since the path module is the real
    // one: what matters is that it found the binary on PATH.
    expect(detected.binary).toMatch(/bwrap$/);
  });

  it('says how to install it when it is not there', async () => {
    const { detectSandbox } = await sandbox();

    const detected = detectSandbox();
    expect(detected.backend).toBe('none');
    expect(detected.reason).toContain('apt install bubblewrap');
  });

  it('does not use one that is installed but cannot start a sandbox', async () => {
    // bubblewrap is on GitHub's Ubuntu runners and cannot create a namespace
    // there. Trusting its presence turned an unavailable sandbox into a broken
    // tool that took every shell command down with it.
    onPath('/usr/bin/bwrap');
    spawned.result = { status: 1, error: undefined };
    const { detectSandbox } = await sandbox();

    const detected = detectSandbox();
    expect(detected.backend).toBe('none');
    expect(detected.reason).toContain('cannot start a sandbox here');
    expect(detected.reason).toContain('unprivileged namespaces');
  });

  it('does not use one that cannot be run at all', async () => {
    onPath('/usr/bin/bwrap');
    spawned.result = { status: null as unknown as number, error: new Error('spawn EACCES') };
    const { detectSandbox } = await sandbox();

    expect(detectSandbox().reason).toContain('spawn EACCES');
  });

  it('probes by asking it to run something trivial', async () => {
    onPath('/usr/bin/bwrap');
    const { detectSandbox } = await sandbox();
    detectSandbox();

    expect(spawned.calls).toHaveLength(1);
    expect(spawned.calls[0]!.args.join(' ')).toContain('exit 0');
  });

  it('decides once, however often it is asked', async () => {
    onPath('/usr/bin/bwrap');
    const { detectSandbox } = await sandbox();

    detectSandbox();
    detectSandbox();
    detectSandbox();

    expect(spawned.calls).toHaveLength(1);
  });
});

describe('on macOS', () => {
  beforeEach(() => setPlatform('darwin'));

  it('uses sandbox-exec from the path', async () => {
    onPath('/usr/bin/sandbox-exec');
    const { detectSandbox } = await sandbox();

    expect(detectSandbox().backend).toBe('seatbelt');
  });

  it('says so when there is none', async () => {
    setEnv('PATH', '/nowhere');
    const { detectSandbox } = await sandbox();

    const detected = detectSandbox();
    expect(detected.backend).toBe('none');
    expect(detected.reason).toContain('sandbox-exec not available');
  });

  it('does not use one that fails its probe', async () => {
    onPath('/usr/bin/sandbox-exec');
    spawned.result = { status: 65, error: undefined };
    const { detectSandbox } = await sandbox();

    expect(detectSandbox().backend).toBe('none');
  });
});

describe('on Windows', () => {
  beforeEach(() => setPlatform('win32'));

  it('says plainly that there is nothing to use', async () => {
    const { detectSandbox } = await sandbox();

    const detected = detectSandbox();
    expect(detected.backend).toBe('none');
    expect(detected.reason).toContain('Windows');
  });
});

describe('turning it off', () => {
  it('takes the operator at their word, without probing anything', async () => {
    setPlatform('linux');
    onPath('/usr/bin/bwrap');
    setEnv('TITAN_CODE_SANDBOX', 'off');
    const { detectSandbox } = await sandbox();

    const detected = detectSandbox();
    expect(detected.backend).toBe('none');
    expect(detected.reason).toContain('TITAN_CODE_SANDBOX=off');
    expect(spawned.calls).toHaveLength(0);
  });
});

describe('what the operator is shown', () => {
  it('names the backend and what it means', async () => {
    setPlatform('linux');
    onPath('/usr/bin/bwrap');
    const { sandboxStatus } = await sandbox();

    const status = sandboxStatus();
    expect(status.label).toBe('sandbox: bubblewrap');
    expect(status.detail).toContain('workspace writable');
    expect(status.detail).toContain('network on');
  });

  it('says the network is off when it was turned off', async () => {
    setPlatform('darwin');
    onPath('/usr/bin/sandbox-exec');
    setEnv('TITAN_CODE_SANDBOX_NETWORK', 'off');
    const { sandboxStatus } = await sandbox();

    const status = sandboxStatus();
    expect(status.label).toBe('sandbox: seatbelt');
    expect(status.detail).toContain('network off');
  });

  it('gives the reason there is no sandbox rather than just saying none', async () => {
    setPlatform('linux');
    const { sandboxStatus } = await sandbox();

    const status = sandboxStatus();
    expect(status.label).toBe('sandbox: none');
    expect(status.detail).toContain('bubblewrap');
  });
});

describe('the command that actually gets run', () => {
  it('wraps it in bubblewrap when there is one', async () => {
    setPlatform('linux');
    onPath('/usr/bin/bwrap');
    const { planSandbox, defaultPolicy } = await sandbox();

    const plan = planSandbox('/bin/sh', ['-c', 'npm test'], defaultPolicy(process.cwd()), process.cwd());

    expect(plan.backend).toBe('bubblewrap');
    expect(plan.command).toMatch(/bwrap$/);
    expect(plan.args.at(-1)).toBe('npm test');
  });

  it('wraps it in a seatbelt profile on macOS', async () => {
    setPlatform('darwin');
    onPath('/usr/bin/sandbox-exec');
    const { planSandbox, defaultPolicy } = await sandbox();

    const plan = planSandbox('/bin/sh', ['-c', 'npm test'], defaultPolicy(process.cwd()), process.cwd());

    expect(plan.backend).toBe('seatbelt');
    expect(plan.args[0]).toBe('-p');
    expect(plan.args[1]).toContain('version 1');
  });

  it('runs it unconfined, with a reason, when there is no backend', async () => {
    setPlatform('win32');
    const { planSandbox, defaultPolicy } = await sandbox();

    const plan = planSandbox('/bin/sh', ['-c', 'npm test'], defaultPolicy(process.cwd()), process.cwd());

    expect(plan.backend).toBe('none');
    expect(plan.command).toBe('/bin/sh');
    expect(plan.unavailableReason).toBeTruthy();
  });

  it('refuses to confine to nothing when every writable root has gone', async () => {
    // A deleted workspace or a vanished temp directory. Confinement with
    // nothing writable is not confinement, it is a command that fails every
    // write for a reason the error will not explain.
    setPlatform('linux');
    onPath('/usr/bin/bwrap');
    const { planSandbox } = await sandbox();

    const plan = planSandbox('/bin/sh', ['-c', 'ls'], {
      writableRoots: ['/tmp/gone-1234567890', '/tmp/gone-0987654321'],
      allowNetwork: true
    }, process.cwd());

    expect(plan.backend).toBe('none');
    expect(plan.unavailableReason).toContain('refusing to confine to nothing');
  });
});
