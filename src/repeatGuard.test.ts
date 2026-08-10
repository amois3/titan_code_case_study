import { describe, expect, it } from 'vitest';
import {
  ABORT_AFTER,
  NO_PROGRESS_ABORT_AFTER,
  NO_PROGRESS_WARN_AFTER,
  RepeatGuard,
  WARN_AFTER,
  describeCall
} from './repeatGuard';

/**
 * The behaviour under test came from a real session.
 *
 * A `cd` outside the workspace was refused; the refusal named a slash command
 * the model cannot invoke; the model rewrote the same call six times with
 * different quoting and escaping, each rejected identically. Nothing noticed,
 * and the turn budget extended itself without limit.
 */
describe('repeat guard', () => {
  const call = (guard: RepeatGuard, command: string, succeeded = false) =>
    guard.record('run_bash', { command }, succeeded);

  it('says nothing about a single failure', () => {
    const guard = new RepeatGuard();
    const verdict = call(guard, 'cd /etc');
    expect(verdict.warning).toBeUndefined();
    expect(verdict.abort).toBeUndefined();
  });

  it('warns once the same call has failed repeatedly', () => {
    const guard = new RepeatGuard();
    for (let i = 1; i < WARN_AFTER; i++) call(guard, 'cd /etc');
    const verdict = call(guard, 'cd /etc');
    expect(verdict.warning).toContain('will not change the result');
    expect(verdict.abort).toBeUndefined();
  });

  it('ends the turn when the warning is ignored', () => {
    const guard = new RepeatGuard();
    let verdict = call(guard, 'cd /etc');
    for (let i = 1; i < ABORT_AFTER; i++) verdict = call(guard, 'cd /etc');
    expect(verdict.abort).toContain('failed');
    expect(verdict.abort).toContain('cd /etc');
  });

  it('treats re-spellings of the same intent as different calls', () => {
    // Honest limit: the guard matches arguments, not meaning. Quoting the path
    // differently produces a different fingerprint, so the counter restarts.
    // What stops that loop is the refusal message, which now says outright
    // that re-spelling will not help. This test records the boundary rather
    // than pretending it is not there.
    const guard = new RepeatGuard();
    call(guard, 'cd /etc');
    const verdict = call(guard, 'cd "/etc"');
    expect(verdict.count).toBe(1);
  });

  it('ignores key order, which models vary between identical calls', () => {
    const guard = new RepeatGuard();
    guard.record('run_bash', { command: 'ls', timeout: 5 }, false);
    const verdict = guard.record('run_bash', { timeout: 5, command: 'ls' }, false);
    expect(verdict.count).toBe(2);
  });

  it('forgets the streak as soon as something succeeds', () => {
    const guard = new RepeatGuard();
    call(guard, 'cd /etc');
    call(guard, 'cd /etc');
    call(guard, 'ls', true);
    expect(call(guard, 'cd /etc').count).toBe(1);
  });

  it('forgets the streak when a different call fails', () => {
    const guard = new RepeatGuard();
    call(guard, 'cd /etc');
    call(guard, 'cd /etc');
    expect(call(guard, 'cat /etc/passwd').count).toBe(1);
  });

  it('warns about a call that keeps succeeding without going anywhere', () => {
    const guard = new RepeatGuard();
    let verdict = guard.record('list_directory', { path: '.' }, true);
    for (let i = 1; i < NO_PROGRESS_WARN_AFTER; i++) {
      verdict = guard.record('list_directory', { path: '.' }, true);
    }
    expect(verdict.warning).toContain('will not change');
    expect(verdict.abort).toBeUndefined();
  });

  it('ends the turn when the same successful call is repeated past the limit', () => {
    const guard = new RepeatGuard();
    let verdict = guard.record('list_directory', { path: '.' }, true);
    for (let i = 1; i < NO_PROGRESS_ABORT_AFTER; i++) {
      verdict = guard.record('list_directory', { path: '.' }, true);
    }
    expect(verdict.abort).toContain('same call was made');
    expect(verdict.abort).toContain('list_directory(.)');
  });

  it('lets a different successful call clear the no-progress streak', () => {
    const guard = new RepeatGuard();
    for (let i = 0; i < NO_PROGRESS_ABORT_AFTER - 1; i++) {
      guard.record('read_file', { filePath: 'a.ts' }, true);
    }
    const verdict = guard.record('read_file', { filePath: 'b.ts' }, true);
    expect(verdict.count).toBe(1);
    expect(verdict.abort).toBeUndefined();
  });

  it('does not count polling a background job as a loop', () => {
    // exec_shell_wait is meant to be called again with the same jobId: the
    // job advances even though the arguments do not.
    const guard = new RepeatGuard();
    let verdict = guard.record('exec_shell_wait', { jobId: 'job_1' }, true);
    for (let i = 1; i < NO_PROGRESS_ABORT_AFTER + 3; i++) {
      verdict = guard.record('exec_shell_wait', { jobId: 'job_1' }, true);
    }
    expect(verdict.warning).toBeUndefined();
    expect(verdict.abort).toBeUndefined();
  });

  it('catches a streak that alternates between failing and succeeding', () => {
    const guard = new RepeatGuard();
    let verdict = guard.record('grep_search', { pattern: 'todo' }, false);
    for (let i = 1; i < NO_PROGRESS_ABORT_AFTER; i++) {
      verdict = guard.record('grep_search', { pattern: 'todo' }, i % 2 === 0);
    }
    expect(verdict.abort).toBeDefined();
  });

  it('names the offending call so the message is actionable', () => {
    expect(describeCall('run_bash', { command: 'cd /etc && ls' })).toBe('run_bash(cd /etc && ls)');
    expect(describeCall('read_file', { filePath: '/tmp/x' })).toBe('read_file(/tmp/x)');
    expect(describeCall('nothing', undefined)).toBe('nothing()');
  });
});
