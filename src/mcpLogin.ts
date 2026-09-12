// mcpLogin.ts - the browser half of signing in to a hosted MCP server.
//
// Everything that can be decided without a browser lives in mcpOAuth.ts and is
// tested there. What is left is the part that cannot be: open a listener the
// authorization server can redirect to, send the operator to the consent page,
// and wait.
//
// The listener binds to loopback and to one path. It is open for as long as the
// operator takes to press Approve and no longer, and it accepts one redirect —
// the one carrying this attempt's own state. Anything else that reaches it is
// answered and ignored.

import { createServer, type Server } from 'node:http';
import { spawn } from 'node:child_process';
import {
  authorizationUrl,
  createPkce,
  createState,
  discoverAuthServer,
  exchangeCode,
  readRedirect,
  registerClient,
  type AuthServerMetadata,
  type Fetch,
  type Tokens
} from './mcpOAuth';

/** Where the redirect lands. Registered with the server, so it cannot drift. */
export const DEFAULT_CALLBACK_PORT = 8765;
export const CALLBACK_PATH = '/callback';

export function callbackUrl(port = DEFAULT_CALLBACK_PORT): string {
  return `http://localhost:${port}${CALLBACK_PATH}`;
}

/** What the operator sees in the tab once the redirect has been caught. */
const DONE_PAGE = `<!doctype html><meta charset="utf-8"><title>Signed in</title>
<body style="font:16px system-ui;padding:3rem;max-width:32rem">
<h1 style="font-size:1.2rem">Signed in.</h1>
<p>The tool has the token. You can close this tab and go back to the terminal.</p>`;

const FAILED_PAGE = `<!doctype html><meta charset="utf-8"><title>Not signed in</title>
<body style="font:16px system-ui;padding:3rem;max-width:32rem">
<h1 style="font-size:1.2rem">That did not complete.</h1>
<p>Go back to the terminal — the reason is there.</p>`;

/** How each desktop is asked to open a URL. Pure, so it can be checked. */
export function browserCommandFor(url: string, platform: NodeJS.Platform): { command: string; args: string[] } {
  if (platform === 'win32') return { command: 'cmd', args: ['/c', 'start', '', url] };
  if (platform === 'darwin') return { command: 'open', args: [url] };
  return { command: 'xdg-open', args: [url] };
}

/**
 * Open the operator's browser, and say so rather than failing if it will not.
 *
 * A headless machine, a locked-down desktop, an SSH session: any of those make
 * this impossible, and none of them should end the flow. The URL is printed
 * either way, and pasting it by hand works exactly as well.
 *
 * `spawnImpl` exists for the tests. Running the real one there would open a
 * browser window on whoever's machine ran the suite, which is not a thing a
 * test may do — so the decision is checked and the spawning is not.
 */
export function openBrowser(
  url: string,
  spawnImpl: typeof spawn = spawn,
  platform: NodeJS.Platform = process.platform
): void {
  try {
    const { command, args } = browserCommandFor(url, platform);
    const child = spawnImpl(command, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => undefined);
    child.unref();
  } catch {
    // Printed by the caller regardless; there is nothing to recover from.
  }
}

interface Caught {
  code: string;
}

function waitForRedirect(
  port: number,
  state: string,
  timeoutMs: number
): { done: Promise<Caught>; close: () => Promise<void> } {
  let server: Server | undefined;
  let settled = false;
  let timer: NodeJS.Timeout | undefined;

  // Awaited, and the same wait however many times it is asked for.
  //
  // `close()` returns before the socket is free, and the caller closes twice —
  // once where the redirect is settled, once in its own finally. Without a
  // shared promise the second call returned at once and the port was still
  // held, so an attempt that ended and was retried was refused its own port —
  // which is exactly what a retry is: the first one failed.
  //
  // Existing keep-alive connections are dropped too. Node waits for them, and
  // the browser leaves one open behind the page it was just shown.
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closing) return closing;
    if (timer) clearTimeout(timer);
    const open = server;
    server = undefined;
    if (!open) {
      closing = Promise.resolve();
      return closing;
    }
    closing = new Promise<void>((resolve) => {
      open.close(() => resolve());
      open.closeAllConnections?.();
    });
    return closing;
  };

  const done = new Promise<Caught>((resolve, reject) => {
    const finish = (run: () => void): void => {
      if (settled) return;
      settled = true;
      run();
      void close();
    };

    server = createServer((request, response) => {
      const path = (request.url ?? '').split('?')[0];
      if (path !== CALLBACK_PATH) {
        response.writeHead(404).end();
        return;
      }
      try {
        const caught = readRedirect(request.url ?? '', state);
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(DONE_PAGE);
        finish(() => resolve(caught));
      } catch (error) {
        response.writeHead(400, { 'content-type': 'text/html; charset=utf-8' }).end(FAILED_PAGE);
        finish(() => reject(error instanceof Error ? error : new Error(String(error))));
      }
    });

    server.on('error', (error) => {
      finish(() => reject(new Error(
        `Could not listen on port ${port} for the sign-in redirect: ${error.message}. ` +
        'Close whatever is using it, or register a different callback port with the server.'
      )));
    });

    server.listen(port, '127.0.0.1');

    timer = setTimeout(() => {
      finish(() => reject(new Error(
        `No redirect arrived within ${Math.round(timeoutMs / 1000)}s. The sign-in was not completed, so nothing was stored.`
      )));
    }, timeoutMs);
  });

  return { done, close };
}

export interface LoginResult {
  clientId: string;
  clientSecret?: string;
  tokens: Tokens;
  metadata: AuthServerMetadata;
}

export interface LoginOptions {
  /** Reuse a client id from an earlier sign-in rather than registering again. */
  clientId?: string;
  clientSecret?: string;
  port?: number;
  timeoutMs?: number;
  /** Where the 401 said the rules live, when it said. */
  hinted?: string;
  scope?: string;
  fetchImpl?: Fetch;
  /** Told what is happening, because most of this is spent waiting on a person. */
  onStep?: (message: string) => void;
  openBrowserImpl?: (url: string) => void;
}

/**
 * Sign in to one hosted MCP server, start to finish.
 *
 * The order matters and each step is reported: a flow that sits silent while a
 * browser fails to open is indistinguishable from one that has hung.
 */
export async function loginToMcpServer(resourceUrl: string, options: LoginOptions = {}): Promise<LoginResult> {
  const port = options.port ?? DEFAULT_CALLBACK_PORT;
  const redirectUri = callbackUrl(port);
  const step = options.onStep ?? ((): void => undefined);
  const open = options.openBrowserImpl ?? openBrowser;

  step('Asking the server where its sign-in rules live…');
  const metadata = await discoverAuthServer(resourceUrl, {
    ...(options.hinted ? { hinted: options.hinted } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {})
  });

  let clientId = options.clientId;
  let clientSecret = options.clientSecret;
  if (!clientId) {
    step('Registering this tool with it…');
    const registered = await registerClient(metadata, redirectUri, {
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {})
    });
    clientId = registered.clientId;
    clientSecret = registered.clientSecret;
  }

  const pkce = createPkce();
  const state = createState();
  const waiting = waitForRedirect(port, state, options.timeoutMs ?? 5 * 60_000);

  try {
    const url = authorizationUrl({
      metadata,
      clientId,
      redirectUri,
      challenge: pkce.challenge,
      state,
      resource: resourceUrl,
      ...(options.scope ? { scope: options.scope } : {})
    });
    step(`Opening your browser to approve it. If nothing opens, go here:\n${url}`);
    open(url);

    const caught = await waiting.done;
    step('Approved. Exchanging that for a token…');
    const tokens = await exchangeCode({
      metadata,
      clientId,
      ...(clientSecret ? { clientSecret } : {}),
      code: caught.code,
      verifier: pkce.verifier,
      redirectUri,
      resource: resourceUrl,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {})
    });
    return { clientId, ...(clientSecret ? { clientSecret } : {}), tokens, metadata };
  } finally {
    // Whatever happened, the listener does not outlive the attempt — and the
    // port is free before this returns, so a retry is not refused its own.
    await waiting.close();
  }
}

/** What signing in needs from the rest of the product, so it can be driven in a test. */
export interface SignInDeps {
  discover: (resourceUrl: string) => Promise<AuthServerMetadata>;
  refresh: (input: {
    metadata: AuthServerMetadata; clientId: string; refreshToken: string; resource?: string;
  }) => Promise<Tokens>;
  login: (resourceUrl: string, options: LoginOptions) => Promise<LoginResult>;
  readSecret: (key: string) => string | undefined;
  writeSecret: (key: string, value: string) => void;
  saveToken: (token: string) => { ok: boolean; message?: string };
  onStep?: (message: string) => void;
}

export interface SignInOutcome {
  ok: boolean;
  /** True when it was renewed without sending anyone to a browser. */
  renewed: boolean;
  message: string;
}

/** Where a server's own sign-in leftovers are kept, keyed by its name. */
export function signInSecretKey(name: string, part: 'CLIENT' | 'REFRESH'): string {
  return `MCP_${part}_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
}

/**
 * Get a live token for one server, the cheapest way that works.
 *
 * A refresh first, because a token that could have been renewed silently is
 * not worth a browser: Upwork's lasts a day, and an unattended run that stops
 * each morning to ask for a login has stopped being unattended. A refresh the
 * server no longer honours is not an error either — it means signing in again,
 * which is what happens next.
 */
export async function signInToServer(name: string, url: string, deps: SignInDeps): Promise<SignInOutcome> {
  const clientId = deps.readSecret(signInSecretKey(name, 'CLIENT'));
  const refreshToken = deps.readSecret(signInSecretKey(name, 'REFRESH'));

  if (clientId && refreshToken) {
    try {
      const metadata = await deps.discover(url);
      const renewed = await deps.refresh({ metadata, clientId, refreshToken, resource: url });
      const stored = deps.saveToken(renewed.accessToken);
      if (!stored.ok) return { ok: false, renewed: true, message: stored.message ?? 'Could not store the renewed token.' };
      if (renewed.refreshToken) deps.writeSecret(signInSecretKey(name, 'REFRESH'), renewed.refreshToken);
      return { ok: true, renewed: true, message: `Renewed the token for ${name} without asking you to sign in again.` };
    } catch {
      // Fall through to a full sign-in, which is what a dead refresh means.
    }
  }

  try {
    const result = await deps.login(url, {
      ...(clientId ? { clientId } : {}),
      ...(deps.onStep ? { onStep: deps.onStep } : {})
    });
    deps.writeSecret(signInSecretKey(name, 'CLIENT'), result.clientId);
    if (result.tokens.refreshToken) deps.writeSecret(signInSecretKey(name, 'REFRESH'), result.tokens.refreshToken);
    const stored = deps.saveToken(result.tokens.accessToken);
    if (!stored.ok) return { ok: false, renewed: false, message: stored.message ?? 'Could not store the token.' };
    return {
      ok: true,
      renewed: false,
      message: [
        `Signed in to ${name}.`,
        result.tokens.refreshToken
          ? 'A refresh token was issued, so this will renew itself rather than asking again.'
          : 'No refresh token was issued, so this will ask again when the token expires.'
      ].join('\n')
    };
  } catch (error) {
    return {
      ok: false,
      renewed: false,
      message: `Not signed in: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

/** What renewing a token without a browser needs, so it can be driven in a test. */
export interface RenewDeps {
  discover: (resourceUrl: string) => Promise<AuthServerMetadata>;
  refresh: (input: {
    metadata: AuthServerMetadata; clientId: string; refreshToken: string; resource?: string;
  }) => Promise<Tokens>;
  readSecret: (key: string) => string | undefined;
  writeSecret: (key: string, value: string) => void;
}

/**
 * A fresh access token, quietly, or nothing.
 *
 * This is the half of signing in that needs no person, split out because the
 * moment it is wanted is the moment nobody is watching: the token lasts a day,
 * and the morning after, the server answers 401 and every tool it publishes
 * disappears. A run told to look for work on Upwork then has no Upwork tools
 * and does the sensible thing with what is left — it opens a browser — which
 * is how a working integration looks broken.
 *
 * No browser here, ever. A refresh token the server will not honour means the
 * operator has to sign in, and that is said rather than done behind their back.
 */
export async function renewAccessToken(name: string, url: string, deps: RenewDeps): Promise<string | undefined> {
  const clientId = deps.readSecret(signInSecretKey(name, 'CLIENT'));
  const refreshToken = deps.readSecret(signInSecretKey(name, 'REFRESH'));
  if (!clientId || !refreshToken) return undefined;

  try {
    const metadata = await deps.discover(url);
    const renewed = await deps.refresh({ metadata, clientId, refreshToken, resource: url });
    if (renewed.refreshToken) deps.writeSecret(signInSecretKey(name, 'REFRESH'), renewed.refreshToken);
    return renewed.accessToken;
  } catch {
    // Dead, revoked, or the server is down. The caller reports what it can and
    // the operator signs in again; guessing further would only delay that.
    return undefined;
  }
}
