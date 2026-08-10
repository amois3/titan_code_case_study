import { accessSync, constants, existsSync } from 'fs';
import { join } from 'path';
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import { defaultPolicy, planSandbox } from './sandbox';

/**
 * Choosing and driving the platform's shell.
 *
 * `spawn('bash', …)` was hardcoded, which meant every shell tool failed on
 * Windows with ENOENT. Substituting `cmd` there is not enough on its own: the
 * model is prompted in POSIX terms and writes `ls -la`, `grep -rn`, `foo &&
 * bar`. Handing that to cmd changes what the command means, and a tool that
 * silently means something else is worse than one that plainly does not run.
 *
 * So the order is: a real POSIX shell wherever one exists — including Git Bash
 * on Windows, which any machine with git already has — then PowerShell, then
 * cmd.
 *
 * The choice is then told to both audiences that have to live with it: the
 * operator through /help and /status, and the model through
 * describeShellForPrompt below. That second half was missing, and this comment
 * claimed otherwise while the agent was left to discover the syntax by failing.
 */

export type ShellKind = 'posix' | 'powershell' | 'cmd';

export interface ShellRuntime {
  kind: ShellKind;
  /** Executable to spawn. */
  command: string;
  /** Arguments placed before the command text. */
  argsFor: (command: string) => string[];
  /** Human-readable name for diagnostics and prompts. */
  label: string;
}

function isExecutable(path: string): boolean {
  // X_OK alone is unreliable on Windows and can pass for a missing Git Bash
  // path that then fails at spawn with ENOENT. Require the file to exist.
  if (!existsSync(path)) return false;
  try {
    accessSync(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return process.platform === 'win32';
  }
}

/** Locates an executable on PATH without running a shell to do it. */
function findOnPath(binary: string): string | null {
  const pathValue = process.env.PATH || '';
  const separator = process.platform === 'win32' ? ';' : ':';
  const extensions = process.platform === 'win32'
    ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';')
    : [''];

  for (const directory of pathValue.split(separator).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = join(directory, binary + extension);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

/** Places Git for Windows installs bash, in order of likelihood. */
const WINDOWS_BASH_LOCATIONS = [
  'C:\\Program Files\\Git\\bin\\bash.exe',
  'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  'C:\\Program Files\\Git\\usr\\bin\\bash.exe'
];

const POSIX_ARGS = (command: string) => ['-c', command];
// -NoProfile keeps a user's profile from changing behaviour between machines;
// -NonInteractive stops a prompt from hanging a tool call forever.
const POWERSHELL_ARGS = (command: string) => ['-NoProfile', '-NonInteractive', '-Command', command];
// /d skips AutoRun registry commands, /s keeps quoting predictable, /c runs and exits.
const CMD_ARGS = (command: string) => ['/d', '/s', '/c', command];

let cached: ShellRuntime | null = null;

/**
 * Existence on disk is not enough on Windows: a broken Git for Windows install
 * leaves bash.exe on PATH that spawn then rejects with ENOENT. Probe is only
 * used there — on Unix a missing or non-executable binary is already filtered
 * by path lookup, and probing every candidate under vitest workers was a
 * source of CI flakes and timeouts.
 */
function canSpawnShell(command: string, args: string[]): boolean {
  try {
    const result = spawnSync(command, args, {
      timeout: 1500,
      stdio: 'ignore',
      windowsHide: true
    });
    if (result.error) return false;
    return result.status === 0;
  } catch {
    return false;
  }
}

function tryWindowsPosix(command: string, label: string): ShellRuntime | null {
  if (!isExecutable(command)) return null;
  if (!canSpawnShell(command, ['-c', 'exit 0'])) return null;
  return { kind: 'posix', command, argsFor: POSIX_ARGS, label };
}

function tryWindowsPowerShell(command: string): ShellRuntime | null {
  if (!isExecutable(command)) return null;
  if (!canSpawnShell(command, ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'])) return null;
  return { kind: 'powershell', command, argsFor: POWERSHELL_ARGS, label: `${command} (PowerShell)` };
}

export function detectShell(): ShellRuntime {
  if (cached) return cached;

  const override = process.env.TITAN_CODE_SHELL;
  if (override) {
    const lower = override.toLowerCase();
    const kind: ShellKind = /pwsh|powershell/.test(lower)
      ? 'powershell'
      : /cmd\.exe$|^cmd$/.test(lower) ? 'cmd' : 'posix';
    const argsFor = kind === 'powershell' ? POWERSHELL_ARGS : kind === 'cmd' ? CMD_ARGS : POSIX_ARGS;
    // On Windows, reject a broken override so we can fall through.
    if (process.platform === 'win32') {
      const probeArgs = kind === 'powershell'
        ? ['-NoProfile', '-NonInteractive', '-Command', 'exit 0']
        : kind === 'cmd'
          ? ['/d', '/s', '/c', 'exit 0']
          : ['-c', 'exit 0'];
      if (!canSpawnShell(override, probeArgs)) {
        // Fall through to normal detection.
      } else {
        cached = {
          kind,
          command: override,
          argsFor,
          label: `${override} (TITAN_CODE_SHELL)`
        };
        return cached;
      }
    } else {
      cached = {
        kind,
        command: override,
        argsFor,
        label: `${override} (TITAN_CODE_SHELL)`
      };
      return cached;
    }
  }

  if (process.platform !== 'win32') {
    // Keep detection simple and side-effect free on Unix: no spawn probe.
    const preferred = process.env.SHELL && /\/(ba|z|k|da)?sh$/.test(process.env.SHELL)
      ? process.env.SHELL
      : null;
    const posix = preferred
      ?? findOnPath('bash')
      ?? (isExecutable('/bin/bash') ? '/bin/bash' : null)
      ?? (isExecutable('/bin/sh') ? '/bin/sh' : 'sh');
    cached = { kind: 'posix', command: posix, argsFor: POSIX_ARGS, label: posix };
    return cached;
  }

  const bashCandidates = [
    findOnPath('bash'),
    ...WINDOWS_BASH_LOCATIONS.filter(isExecutable)
  ].filter((c): c is string => Boolean(c));

  for (const candidate of bashCandidates) {
    const runtime = tryWindowsPosix(candidate, `${candidate} (POSIX)`);
    if (runtime) {
      cached = runtime;
      return cached;
    }
  }

  for (const candidate of [findOnPath('pwsh'), findOnPath('powershell')].filter((c): c is string => Boolean(c))) {
    const runtime = tryWindowsPowerShell(candidate);
    if (runtime) {
      cached = runtime;
      return cached;
    }
  }

  const cmd = process.env.ComSpec || 'cmd.exe';
  cached = { kind: 'cmd', command: cmd, argsFor: CMD_ARGS, label: `${cmd} (cmd)` };
  return cached;
}

/** Test seam: forget the detected shell so the next call probes again. */
export function resetShellCache(): void {
  cached = null;
}

/**
 * What the model needs to know about the shell it is about to use.
 *
 * The detected shell was reported to `/help` and `/status` and nowhere else,
 * so the operator could see it and the agent could not. On Windows that gap
 * has a predictable cost: the machine is Windows, the task is a Windows task,
 * the tool is called `run_bash` with no further detail — and the model reaches
 * for PowerShell, gets a syntax error, and has to find the boundary by hitting
 * it. Three wasted calls to learn something the process already knew at
 * startup.
 *
 * Kept next to the detection it describes, so the two cannot drift apart.
 */
export function describeShellForPrompt(): string {
  const shell = detectShell();
  const lines = [`Shell used by run_bash: ${shell.label}`];

  if (shell.kind === 'posix') {
    lines.push('It is a POSIX shell. Write POSIX syntax: single quotes, $VAR, &&, ||, rm, ls, grep.');
    if (process.platform === 'win32') {
      lines.push(
        'This is Windows, but the shell is not PowerShell or cmd. PowerShell syntax ' +
        '($x = @(...), Remove-Item, Get-ChildItem, -Force) is a syntax error here.'
      );
      lines.push(
        'Backslashes are escape characters: write C:/Users/name/file or quote the path ' +
        "as 'C:\\Users\\name\\file'."
      );
      lines.push(
        'If a task genuinely needs PowerShell, invoke it on purpose rather than by habit: ' +
        'powershell.exe -NoProfile -Command \'...\' — single quotes, because inside double quotes ' +
        'this shell expands $_ and $variables before PowerShell ever sees them, and $_.Name arrives ' +
        'as something else entirely. For anything longer than one line, write a .ps1 file and run that.'
      );
    }
  } else if (shell.kind === 'powershell') {
    lines.push('It is PowerShell. Use PowerShell syntax and cmdlets.');
    lines.push(
      'POSIX idioms do not carry over: ls -la, grep, rm -rf, and $VAR mean something ' +
      'else or nothing at all. Use Get-ChildItem, Select-String, Remove-Item, $env:VAR.'
    );
  } else {
    lines.push('It is cmd.exe. Use cmd syntax: %VAR%, dir, del, copy.');
    lines.push('Neither POSIX nor PowerShell idioms work here; && chains but || does not behave the same.');
  }

  return lines.join('\n');
}

export interface SpawnShellOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  /**
   * Confine the process to `cwd` using the host's sandbox. Left off for
   * user-authored hooks, which are the operator's own code rather than the
   * model's and are expected to reach outside the workspace.
   */
  sandbox?: boolean;
}

export function spawnShell(command: string, options: SpawnShellOptions): ChildProcess {
  const shell = detectShell();
  const shellArgs = shell.argsFor(command);

  const plan = options.sandbox
    ? planSandbox(shell.command, shellArgs, defaultPolicy(options.cwd), options.cwd)
    : { command: shell.command, args: shellArgs };

  return spawn(plan.command, plan.args, {
    cwd: options.cwd,
    env: options.env,
    // Without a group of its own a timeout can only kill the shell, leaving
    // whatever it started running. See terminateTree.
    detached: process.platform !== 'win32'
  });
}

/**
 * Stops a process and everything it started.
 *
 * `child.kill()` signals one process. A shell command routinely spawns
 * children — `npm test` alone starts several — and on a timeout those keep
 * running, holding ports and writing files long after the tool reported
 * failure. POSIX gets a signal to the whole process group; Windows has no
 * groups, so taskkill walks the tree instead.
 */
export function terminateTree(child: ChildProcess, signal: NodeJS.Signals = 'SIGKILL'): void {
  if (child.pid === undefined) return;

  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      try { child.kill(signal); } catch { /* already gone */ }
    }
    return;
  }

  try {
    // Negative pid targets the group created by `detached: true`.
    process.kill(-child.pid, signal);
  } catch {
    try { child.kill(signal); } catch { /* already gone */ }
  }
}
