import { accessSync, constants, existsSync, realpathSync } from 'fs';
import { spawnSync } from 'child_process';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

/** Prefer the kernel's view of a path so Seatbelt subpaths match /private/var. */
function realResolve(input: string): string {
  const absolute = resolve(input);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

/**
 * Kernel-level confinement for shell commands.
 *
 * Reading a command string can narrow risk but never bound it: the analysis in
 * shellPolicy closes the spellings we know about, and a shell has more
 * spellings than anyone enumerates. The operating system, by contrast, does
 * not care how the write was spelled. So the policy filters, the approval gate
 * asks, and the sandbox is what actually contains.
 *
 * Backends, in the order they are preferred:
 *
 *   bubblewrap  Linux. Mounts the filesystem read-only, binds the workspace
 *               writable, and gives the process its own namespaces. This is
 *               the mechanism Claude Code's sandbox runtime uses.
 *   seatbelt    macOS, via sandbox-exec and a generated profile. The same
 *               mechanism Codex CLI uses there.
 *   none        Windows, and any host lacking the above. There is no
 *               equivalent reachable from Node without a native addon, and
 *               claiming otherwise would be worse than saying so.
 */

export type SandboxBackend = 'bubblewrap' | 'seatbelt' | 'none';

export interface SandboxPolicy {
  /** Directories the command may modify. */
  writableRoots: string[];
  /** Whether the command may reach the network. */
  allowNetwork: boolean;
}

export interface SandboxPlan {
  backend: SandboxBackend;
  /** Executable to spawn, already wrapping the shell invocation. */
  command: string;
  args: string[];
  /** Why confinement is absent, when it is. */
  unavailableReason?: string;
}

export interface SandboxStatus {
  backend: SandboxBackend;
  label: string;
  detail: string;
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findOnPath(binary: string): string | null {
  const separator = process.platform === 'win32' ? ';' : ':';
  for (const dir of (process.env.PATH || '').split(separator).filter(Boolean)) {
    const candidate = join(dir, binary);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

/**
 * Runs a trivial command through the backend to see whether it actually works.
 *
 * Presence on PATH is not capability. bubblewrap is installed on GitHub's
 * Ubuntu runners and cannot create a namespace there, so it exists, is
 * selected, and fails — taking every shell command down with it. A container
 * without the right privileges, or a host with unprivileged user namespaces
 * disabled, behaves the same way.
 *
 * Trusting the binary's existence turned an unavailable sandbox into a broken
 * tool. Asking it to run `true` costs a few milliseconds once per process and
 * gives a reason worth printing.
 *
 * Returns null when confinement works, or the reason it does not.
 */
function probe(backend: SandboxBackend, binary: string): string | null {
  const workdir = tmpdir();
  const policy: SandboxPolicy = { writableRoots: [resolve(workdir)], allowNetwork: true };
  const args = backend === 'bubblewrap'
    ? [...bubblewrapArgs(policy, workdir), '/bin/sh', '-c', 'exit 0']
    : ['-p', seatbeltProfile(policy), '/bin/sh', '-c', 'exit 0'];

  try {
    const result = spawnSync(binary, args, { timeout: 5000, stdio: 'ignore' });
    if (result.error) return `${backend} present but unusable: ${result.error.message}`;
    if (result.status !== 0) {
      return `${backend} present but cannot start a sandbox here (exit ${result.status}); ` +
        'unprivileged namespaces are often disabled in containers and CI runners';
    }
    return null;
  } catch (error) {
    return `${backend} probe failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

let detected: { backend: SandboxBackend; binary: string | null; reason?: string } | null = null;

export function detectSandbox(): { backend: SandboxBackend; binary: string | null; reason?: string } {
  if (detected) return detected;

  if (process.env.TITAN_CODE_SANDBOX === 'off') {
    detected = { backend: 'none', binary: null, reason: 'disabled by TITAN_CODE_SANDBOX=off' };
    return detected;
  }

  if (process.platform === 'linux') {
    const bwrap = findOnPath('bwrap');
    if (!bwrap) {
      detected = { backend: 'none', binary: null, reason: 'bubblewrap not installed (apt install bubblewrap)' };
      return detected;
    }
    const failure = probe('bubblewrap', bwrap);
    detected = failure
      ? { backend: 'none', binary: null, reason: failure }
      : { backend: 'bubblewrap', binary: bwrap };
    return detected;
  }

  if (process.platform === 'darwin') {
    const seatbelt = findOnPath('sandbox-exec') ?? (isExecutable('/usr/bin/sandbox-exec') ? '/usr/bin/sandbox-exec' : null);
    if (!seatbelt) {
      detected = { backend: 'none', binary: null, reason: 'sandbox-exec not available' };
      return detected;
    }
    const failure = probe('seatbelt', seatbelt);
    detected = failure
      ? { backend: 'none', binary: null, reason: failure }
      : { backend: 'seatbelt', binary: seatbelt };
    return detected;
  }

  detected = {
    backend: 'none',
    binary: null,
    reason: 'Windows has no filesystem sandbox reachable without a native addon'
  };
  return detected;
}

/** Test seam: forget the detected backend so the next call probes again. */
export function resetSandboxCache(): void {
  detected = null;
}

/**
 * Whether shell commands may use the network.
 *
 * Enabled unless asked otherwise. Cutting it would break `npm install` and
 * `pip install` — the commands people run most — while closing nothing, since
 * the agent's own fetch and web_search tools reach the network through Node
 * and never touch this sandbox. A sandbox that makes ordinary work impossible
 * gets switched off, and a switched-off sandbox protects nothing.
 */
export function networkAllowed(): boolean {
  return process.env.TITAN_CODE_SANDBOX_NETWORK !== 'off';
}

export function defaultPolicy(workspaceRoot: string): SandboxPolicy {
  const workspace = realResolve(workspaceRoot);
  const writable = [workspace];
  // Build tools write to the temporary directory as a matter of course;
  // without it even `tsc` fails inside the sandbox.
  const temp = realResolve(tmpdir());
  if (temp !== workspace && !temp.startsWith(workspace + '/') && !temp.startsWith(workspace + '\\')) {
    writable.push(temp);
  }
  return { writableRoots: writable, allowNetwork: networkAllowed() };
}

function bubblewrapArgs(policy: SandboxPolicy, workdir: string): string[] {
  const args = [
    // Everything is visible but read-only; the writable set is added back
    // explicitly below. Read access is deliberately broad: toolchains live
    // all over the filesystem, and the containment that matters is on writes.
    '--ro-bind', '/', '/',
    '--dev', '/dev',
    '--proc', '/proc',
    '--die-with-parent',
    // A new session keeps the sandboxed process from reaching back to the
    // terminal that started it.
    '--new-session'
  ];

  for (const root of policy.writableRoots) {
    const real = realResolve(root);
    if (existsSync(real)) args.push('--bind', real, real);
  }

  if (!policy.allowNetwork) args.push('--unshare-net');

  args.push('--chdir', realResolve(workdir), '--');
  return args;
}

/**
 * Builds a Seatbelt profile.
 *
 * Written deny-by-default for writes and allow for reads, matching the
 * bubblewrap policy so the two platforms behave the same way rather than
 * merely both being "sandboxed".
 */
function seatbeltProfile(policy: SandboxPolicy): string {
  const lines = [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    '(allow file-read*)'
  ];
  for (const root of policy.writableRoots) {
    // Seatbelt matches real paths; /var vs /private/var must agree or every
    // legitimate write is denied and the sandbox looks broken.
    lines.push(`(allow file-write* (subpath ${JSON.stringify(realResolve(root))}))`);
  }
  // Writing to the terminal and to null devices is not a filesystem effect in
  // any meaningful sense, and denying it breaks ordinary output.
  lines.push('(allow file-write-data (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr") (literal "/dev/tty"))');
  if (!policy.allowNetwork) lines.push('(deny network*)');
  return lines.join('\n');
}

/**
 * Wraps a shell invocation in whatever confinement the host supports.
 *
 * Returns the original invocation unchanged when no backend exists, with the
 * reason attached so callers can say so out loud instead of implying a
 * protection that is not there.
 */
export function planSandbox(
  shellCommand: string,
  shellArgs: string[],
  policy: SandboxPolicy,
  workdir: string
): SandboxPlan {
  const { backend, binary, reason } = detectSandbox();

  if (backend === 'bubblewrap' && binary) {
    return {
      backend,
      command: binary,
      args: [...bubblewrapArgs(policy, workdir), shellCommand, ...shellArgs]
    };
  }

  if (backend === 'seatbelt' && binary) {
    return {
      backend,
      command: binary,
      args: ['-p', seatbeltProfile(policy), shellCommand, ...shellArgs]
    };
  }

  return { backend: 'none', command: shellCommand, args: shellArgs, unavailableReason: reason };
}

/** One line describing the active confinement, for the status bar and /status. */
export function sandboxStatus(): SandboxStatus {
  const { backend, reason } = detectSandbox();
  const network = networkAllowed() ? 'network on' : 'network off';

  if (backend === 'bubblewrap') {
    return { backend, label: 'sandbox: bubblewrap', detail: `workspace writable, rest read-only, ${network}` };
  }
  if (backend === 'seatbelt') {
    return { backend, label: 'sandbox: seatbelt', detail: `workspace writable, rest read-only, ${network}` };
  }
  return {
    backend: 'none',
    label: 'sandbox: none',
    detail: reason ?? 'no kernel confinement on this host'
  };
}
