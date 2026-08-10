import { afterEach, describe, expect, it } from 'vitest';
import { describeShellForPrompt, detectShell, resetShellCache, spawnShell, terminateTree } from './shellRuntime';

const originalShellOverride = process.env.TITAN_CODE_SHELL;

afterEach(() => {
  if (originalShellOverride === undefined) delete process.env.TITAN_CODE_SHELL;
  else process.env.TITAN_CODE_SHELL = originalShellOverride;
  resetShellCache();
});

describe('detectShell', () => {
  it('returns a shell runtime with a command and label', () => {
    resetShellCache();
    const shell = detectShell();
    expect(shell.command.length).toBeGreaterThan(0);
    expect(shell.label.length).toBeGreaterThan(0);
    expect(['posix', 'powershell', 'cmd']).toContain(shell.kind);
    // Probe should have selected something that can at least start.
    expect(typeof shell.argsFor('echo ok')).toBe('object');
  });
});

/**
 * The detected shell reached /help and /status and stopped there. On Windows
 * that left the model to discover, by failing three times, that `run_bash` is
 * Git Bash rather than PowerShell.
 */
describe('describeShellForPrompt', () => {
  it('names the actual shell so the model does not have to guess', () => {
    resetShellCache();
    const described = describeShellForPrompt();
    expect(described).toContain(detectShell().label);
    expect(described.split('\n').length).toBeGreaterThan(1);
  });

  it('states which syntax is in force', () => {
    resetShellCache();
    const described = describeShellForPrompt();
    const kind = detectShell().kind;
    if (kind === 'posix') {
      expect(described).toContain('POSIX');
    } else if (kind === 'powershell') {
      expect(described).toContain('PowerShell');
    } else {
      expect(described).toContain('cmd.exe');
    }
  });

  it('warns a Windows POSIX shell about the two things that actually bite', () => {
    resetShellCache();
    if (process.platform !== 'win32' || detectShell().kind !== 'posix') return;
    const described = describeShellForPrompt();
    // The PowerShell reflex, and backslashes eaten as escapes.
    expect(described).toContain('not PowerShell');
    expect(described).toContain('Backslashes');
    expect(described).toContain('powershell.exe -NoProfile');
  });
});

describe('the arguments each shell is given', () => {
  it('keeps a PowerShell call from reading the profile or waiting for input', () => {
    // A user profile changes behaviour between machines, and an interactive
    // prompt hangs a tool call with nothing on screen to explain it.
    process.env.TITAN_CODE_SHELL = 'pwsh';
    resetShellCache();

    const shell = detectShell();
    if (shell.kind !== 'powershell') return; // the override was rejected here
    expect(shell.argsFor('Get-ChildItem')).toEqual(['-NoProfile', '-NonInteractive', '-Command', 'Get-ChildItem']);
  });

  it('keeps cmd away from AutoRun and predictable about quoting', () => {
    process.env.TITAN_CODE_SHELL = 'cmd.exe';
    resetShellCache();

    const shell = detectShell();
    if (shell.kind !== 'cmd') return;
    expect(shell.argsFor('dir')).toEqual(['/d', '/s', '/c', 'dir']);
  });

  it('passes a POSIX command as one string after -c', () => {
    // Splitting it would change what `a && b` means.
    resetShellCache();
    const shell = detectShell();
    if (shell.kind !== 'posix') return;
    expect(shell.argsFor('ls -la && echo done')).toEqual(['-c', 'ls -la && echo done']);
  });
});

describe('the shell override', () => {
  it('reads the kind from the name it was given', () => {
    for (const [value, expected] of [['pwsh', 'powershell'], ['powershell.exe', 'powershell'], ['cmd', 'cmd'], ['/bin/zsh', 'posix']] as const) {
      process.env.TITAN_CODE_SHELL = value;
      resetShellCache();
      const shell = detectShell();
      // On Windows an override that cannot start is rejected and detection
      // falls through, which is the behaviour that matters more than the kind.
      if (shell.label.includes('TITAN_CODE_SHELL')) {
        expect(shell.kind, value).toBe(expected);
      }
    }
  });

  it('says in the label that the shell was chosen by the operator', () => {
    process.env.TITAN_CODE_SHELL = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';
    resetShellCache();

    const shell = detectShell();
    if (shell.label.includes('TITAN_CODE_SHELL')) {
      expect(shell.label).toContain(process.env.TITAN_CODE_SHELL);
    }
  });

  it('falls through to detection rather than failing on a shell that is not there', () => {
    // An override pointing at nothing must not leave every shell tool broken.
    process.env.TITAN_CODE_SHELL = 'definitely-not-a-shell-xyz';
    resetShellCache();

    const shell = detectShell();
    expect(shell.command.length).toBeGreaterThan(0);
    if (process.platform === 'win32') {
      expect(shell.label).not.toContain('definitely-not-a-shell-xyz');
    }
  });

  it('remembers what it chose rather than probing on every call', () => {
    resetShellCache();
    const first = detectShell();
    expect(detectShell()).toBe(first);
  });
});

describe('running something', () => {
  it('runs a command and gives back what it printed', async () => {
    resetShellCache();
    const child = spawnShell('echo titan-runtime-test', { cwd: process.cwd(), env: process.env });

    const output = await new Promise<string>((resolve) => {
      let text = '';
      child.stdout?.on('data', (chunk) => { text += String(chunk); });
      child.on('close', () => resolve(text));
    });

    expect(output).toContain('titan-runtime-test');
  });

  it('stops a process that would otherwise outlive the call', async () => {
    // `child.kill()` signals one process; a shell command routinely starts
    // several, and on a timeout those keep holding ports and writing files.
    resetShellCache();
    const child = spawnShell('node -e "setTimeout(() => {}, 30000)"', { cwd: process.cwd(), env: process.env });
    await new Promise((resolve) => setTimeout(resolve, 300));

    terminateTree(child);

    const code = await new Promise<number | null>((resolve) => {
      child.on('close', (exitCode) => resolve(exitCode));
      setTimeout(() => resolve(-1), 5000);
    });
    expect(code, 'the shell should be gone, not still running').not.toBe(-1);
  }, 15_000);

  it('does nothing to a process that has already gone', () => {
    resetShellCache();
    expect(() => terminateTree({ pid: undefined } as never)).not.toThrow();
  });
});
