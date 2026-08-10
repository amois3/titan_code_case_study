import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Which shell `run_bash` actually runs.
 *
 * On Unix it is bash and there is nothing to decide. On Windows it is Git Bash
 * if there is one, PowerShell if not, and cmd as the last resort — and every
 * command the model writes assumes an answer to that question. Getting it
 * wrong is not a failed command, it is a command that means something else.
 *
 * The Unix branches cannot run on Windows, so the platform and the binaries
 * are stood in for here. What is under test is the choice, not the shells.
 */
const spawned = vi.hoisted(() => ({
  calls: [] as Array<{ command: string; args: string[] }>,
  failing: new Set<string>()
}));

const files = vi.hoisted(() => ({ present: new Set<string>() }));

function normalise(path: string): string {
  return String(path).replace(/\\/g, '/');
}

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    spawnSync: (command: string, args: string[]) => {
      spawned.calls.push({ command, args });
      return { status: spawned.failing.has(normalise(command)) ? 1 : 0, error: undefined } as ReturnType<typeof actual.spawnSync>;
    }
  };
});

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: (path: string) => files.present.has(normalise(path)),
    accessSync: () => undefined
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

function installed(...paths: string[]): void {
  for (const path of paths) files.present.add(normalise(path));
}

async function runtime() {
  const module = await import('./shellRuntime.js');
  module.resetShellCache();
  return module;
}

beforeEach(() => {
  spawned.calls = [];
  spawned.failing = new Set();
  files.present = new Set();
  setEnv('TITAN_CODE_SHELL', undefined);
  setEnv('PATH', '');
  setEnv('PATHEXT', '.EXE');
  setEnv('SHELL', undefined);
  setEnv('ComSpec', 'C:\\Windows\\System32\\cmd.exe');
  vi.resetModules();
});

afterEach(async () => {
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  for (const [key, value] of envBackup.entries()) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  envBackup.clear();
  const { resetShellCache } = await import('./shellRuntime.js');
  resetShellCache();
  vi.resetModules();
});

describe('on Windows', () => {
  beforeEach(() => setPlatform('win32'));

  it('prefers Git Bash where it is installed', async () => {
    installed('C:/Program Files/Git/bin/bash.exe');
    const { detectShell } = await runtime();

    const shell = detectShell();
    expect(shell.kind).toBe('posix');
    expect(shell.command).toContain('bash.exe');
  });

  it('looks in the other places Git for Windows puts it', async () => {
    installed('C:/Program Files/Git/usr/bin/bash.exe');
    const { detectShell } = await runtime();

    expect(detectShell().kind).toBe('posix');
  });

  it('takes bash from PATH before the well-known locations', async () => {
    setEnv('PATH', 'C:\\tools');
    installed('C:/tools/bash.EXE', 'C:/Program Files/Git/bin/bash.exe');
    const { detectShell } = await runtime();

    expect(normalise(detectShell().command)).toContain('tools/bash');
  });

  it('falls back to PowerShell when the bash it found cannot start', async () => {
    // A bash.exe left behind by an uninstall exists and does nothing.
    installed('C:/Program Files/Git/bin/bash.exe');
    spawned.failing.add('C:/Program Files/Git/bin/bash.exe');
    setEnv('PATH', 'C:\\ps');
    installed('C:/ps/pwsh.EXE');
    const { detectShell } = await runtime();

    const shell = detectShell();
    expect(shell.kind).toBe('powershell');
    expect(shell.label).toContain('PowerShell');
  });

  it('falls back to cmd when nothing else will start', async () => {
    const { detectShell } = await runtime();

    const shell = detectShell();
    expect(shell.kind).toBe('cmd');
    expect(shell.command).toContain('cmd.exe');
  });

  it('does not use a PowerShell that will not start either', async () => {
    setEnv('PATH', 'C:\\ps');
    installed('C:/ps/powershell.EXE');
    spawned.failing.add('C:/ps/powershell.EXE');
    const { detectShell } = await runtime();

    expect(detectShell().kind).toBe('cmd');
  });

  it('probes what it found rather than trusting the file is there', async () => {
    installed('C:/Program Files/Git/bin/bash.exe');
    const { detectShell } = await runtime();
    detectShell();

    expect(spawned.calls.length).toBeGreaterThan(0);
    expect(spawned.calls[0]!.args).toContain('exit 0');
  });
});

describe('on Unix', () => {
  beforeEach(() => setPlatform('linux'));

  it('uses the login shell when it is one this understands', async () => {
    setEnv('SHELL', '/usr/bin/zsh');
    const { detectShell } = await runtime();

    const shell = detectShell();
    expect(shell.kind).toBe('posix');
    expect(shell.command).toBe('/usr/bin/zsh');
  });

  it('ignores a login shell that is not a shell this understands', async () => {
    setEnv('SHELL', '/usr/bin/fish');
    installed('/bin/bash');
    const { detectShell } = await runtime();

    expect(detectShell().command).toBe('/bin/bash');
  });

  it('finds bash on PATH', async () => {
    setEnv('PATH', '/usr/local/bin:/usr/bin');
    installed('/usr/local/bin/bash');
    const { detectShell } = await runtime();

    expect(normalise(detectShell().command)).toBe('/usr/local/bin/bash');
  });

  it('falls back to /bin/sh, and then to the name alone', async () => {
    installed('/bin/sh');
    const { detectShell } = await runtime();
    expect(detectShell().command).toBe('/bin/sh');

    files.present.clear();
    const again = await runtime();
    expect(again.detectShell().command).toBe('sh');
  });

  it('does not spawn anything to decide', async () => {
    // Detection on Unix is meant to be side-effect free.
    installed('/bin/bash');
    const { detectShell } = await runtime();
    detectShell();

    expect(spawned.calls).toHaveLength(0);
  });
});

describe('an override the operator set', () => {
  it('is taken as it stands on Unix', async () => {
    setPlatform('linux');
    setEnv('TITAN_CODE_SHELL', '/opt/homebrew/bin/fish');
    const { detectShell } = await runtime();

    const shell = detectShell();
    expect(shell.command).toBe('/opt/homebrew/bin/fish');
    expect(shell.label).toContain('TITAN_CODE_SHELL');
    expect(spawned.calls).toHaveLength(0);
  });

  it('is probed on Windows, where it may name nothing at all', async () => {
    setPlatform('win32');
    setEnv('TITAN_CODE_SHELL', 'C:\\nope\\bash.exe');
    spawned.failing.add('C:/nope/bash.exe');
    const { detectShell } = await runtime();

    // Falls through to detection rather than failing every command.
    expect(detectShell().command).not.toContain('nope');
  });

  it('reads the kind of shell from the name', async () => {
    setPlatform('win32');
    for (const [name, kind] of [['pwsh.exe', 'powershell'], ['cmd.exe', 'cmd'], ['bash.exe', 'posix']] as const) {
      setEnv('TITAN_CODE_SHELL', `C:\\shells\\${name}`);
      vi.resetModules();
      const { detectShell, resetShellCache } = await import('./shellRuntime.js');
      resetShellCache();

      expect(detectShell().kind, name).toBe(kind);
    }
  });
});
