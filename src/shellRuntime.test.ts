import { describe, expect, it } from 'vitest';
import { detectShell, resetShellCache } from './shellRuntime';

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
