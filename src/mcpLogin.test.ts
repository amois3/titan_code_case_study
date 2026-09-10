import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { browserCommandFor, callbackUrl, loginToMcpServer, openBrowser, signInSecretKey, signInToServer } from './mcpLogin';

/**
 * The half that needs a browser, driven without one.
 *
 * The listener here is real: a port is opened, a redirect is sent to it over
 * HTTP, and the code comes back out. Only the browser is stood in for, because
 * what it does is visit a URL — and a test can visit a URL.
 */

/**
 * A port the OS says is free, asked for at the moment of use.
 *
 * Fixed numbers made these fail for a reason that had nothing to do with them:
 * a listener left behind by an earlier run still held 8791, and the test
 * reported "address already in use" as though the code were at fault.
 */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

const AUTH_SERVER = {
  issuer: 'https://mcp.example.test',
  authorization_endpoint: 'https://www.example.test/oauth2/authorize',
  token_endpoint: 'https://www.example.test/api/oauth2/token',
  registration_endpoint: 'https://www.example.test/register',
  code_challenge_methods_supported: ['S256']
};

function json(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body)
  } as unknown as Response;
}

/** A server that discovers, registers and issues, recording what it was sent. */
function fakeServer(): { fetchImpl: (url: string, init?: RequestInit) => Promise<Response>; tokenForm: () => URLSearchParams } {
  let form = new URLSearchParams();
  return {
    tokenForm: () => form,
    fetchImpl: async (url: string, init?: RequestInit): Promise<Response> => {
      if (url.includes('oauth-protected-resource')) {
        return json({ resource: 'https://mcp.example.test/mcp', authorization_servers: ['https://mcp.example.test'] });
      }
      if (url.includes('oauth-authorization-server')) return json(AUTH_SERVER);
      if (url.endsWith('/register')) return json({ client_id: 'issued-id' }, 201);
      if (url.includes('/token')) {
        form = new URLSearchParams(String(init?.body));
        return json({ access_token: 'live-token', refresh_token: 'renew-me', expires_in: 3600 });
      }
      return json({}, 404);
    }
  };
}

/** Stands in for the browser: follows the URL to the listener, as a person would. */
function visitor(port: number): (url: string) => void {
  return (url: string): void => {
    const state = new URL(url).searchParams.get('state') ?? '';
    setTimeout(() => {
      void fetch(`http://localhost:${port}/callback?code=THE_CODE&state=${encodeURIComponent(state)}`)
        .catch(() => undefined);
    }, 20);
  };
}

describe('signing in to a hosted MCP server', () => {
  it('discovers, registers, catches the redirect and comes back with a token', async () => {
    const port = await freePort();
    const server = fakeServer();

    const result = await loginToMcpServer('https://mcp.example.test/mcp', {
      port,
      fetchImpl: server.fetchImpl,
      openBrowserImpl: visitor(port)
    });

    expect(result.clientId).toBe('issued-id');
    expect(result.tokens).toMatchObject({ accessToken: 'live-token', refreshToken: 'renew-me' });
    // The verifier, not the challenge: the proof is completed at the token
    // endpoint by the process that started it.
    expect(server.tokenForm().get('code_verifier')).toBeTruthy();
    expect(server.tokenForm().get('grant_type')).toBe('authorization_code');
    expect(server.tokenForm().get('redirect_uri')).toBe(callbackUrl(port));
  });

  it('passes on a hint, a scope and a secret rather than dropping them', async () => {
    const port = await freePort();
    const server = fakeServer();
    const steps: string[] = [];
    let approvalUrl = '';

    const result = await loginToMcpServer('https://mcp.example.test/mcp', {
      port,
      clientId: 'known-already',
      clientSecret: 'and-a-secret',
      // What the 401 said, when it said: skips a round of guessing.
      hinted: 'https://mcp.example.test/.well-known/oauth-authorization-server',
      scope: 'pub-submit-proposal:write:all',
      onStep: (message) => steps.push(message),
      fetchImpl: server.fetchImpl,
      openBrowserImpl: (url) => { approvalUrl = url; visitor(port)(url); }
    });

    expect(new URL(approvalUrl).searchParams.get('scope')).toBe('pub-submit-proposal:write:all');
    expect(result.clientSecret).toBe('and-a-secret');
    expect(server.tokenForm().get('client_secret')).toBe('and-a-secret');
    // Most of this is spent waiting on a person; silence reads as a hang.
    expect(steps.some((message) => message.includes('Opening your browser'))).toBe(true);
  });

  it('reuses a client id from an earlier sign-in instead of registering again', async () => {
    const port = await freePort();
    const asked: string[] = [];
    const server = fakeServer();

    await loginToMcpServer('https://mcp.example.test/mcp', {
      port,
      clientId: 'known-already',
      fetchImpl: async (url, init) => { asked.push(url); return server.fetchImpl(url, init); },
      openBrowserImpl: visitor(port)
    });

    expect(asked.some((url) => url.endsWith('/register'))).toBe(false);
    expect(server.tokenForm().get('client_id')).toBe('known-already');
  });

  it('ignores a redirect carrying somebody else\'s state', async () => {
    const port = await freePort();
    const server = fakeServer();

    await expect(loginToMcpServer('https://mcp.example.test/mcp', {
      port,
      timeoutMs: 3_000,
      fetchImpl: server.fetchImpl,
      // A listener on loopback is open to whatever reaches it.
      openBrowserImpl: () => {
        setTimeout(() => {
          void fetch(`http://localhost:${port}/callback?code=STOLEN&state=NOT_OURS`).catch(() => undefined);
        }, 20);
      }
    })).rejects.toThrow(/different state/);
  });

  it('gives up rather than waiting for ever on a person who walked away', async () => {
    const port = await freePort();
    const server = fakeServer();

    await expect(loginToMcpServer('https://mcp.example.test/mcp', {
      port,
      timeoutMs: 300,
      fetchImpl: server.fetchImpl,
      openBrowserImpl: () => undefined
    })).rejects.toThrow(/No redirect arrived/);
  });

  it('frees the port when the attempt ends, so the next one can start', async () => {
    const port = await freePort();
    const server = fakeServer();

    await expect(loginToMcpServer('https://mcp.example.test/mcp', {
      port, timeoutMs: 300, fetchImpl: server.fetchImpl, openBrowserImpl: () => undefined
    })).rejects.toThrow();

    // The proof that the listener closed: the same port is usable immediately.
    const second = await loginToMcpServer('https://mcp.example.test/mcp', {
      port, fetchImpl: server.fetchImpl, openBrowserImpl: visitor(port)
    });
    expect(second.tokens.accessToken).toBe('live-token');
  });

  it('says what happened when the operator refuses on the consent page', async () => {
    const port = await freePort();
    const server = fakeServer();

    await expect(loginToMcpServer('https://mcp.example.test/mcp', {
      port,
      timeoutMs: 3_000,
      fetchImpl: server.fetchImpl,
      openBrowserImpl: (url) => {
        const state = new URL(url).searchParams.get('state') ?? '';
        setTimeout(() => {
          void fetch(`http://localhost:${port}/callback?error=access_denied&state=${encodeURIComponent(state)}`)
            .catch(() => undefined);
        }, 20);
      }
    })).rejects.toThrow(/access_denied/);
  });
});

/**
 * Getting a live token the cheapest way that works.
 *
 * A token from Upwork lasts a day and comes with a refresh token. Sending the
 * operator to a browser each morning for something that could have been
 * renewed silently is an interruption with nothing behind it — and an
 * unattended run that stops to ask for a login has stopped being unattended.
 */
describe('signing in, or not having to', () => {
  const metadata = {
    issuer: 'https://mcp.example.test',
    authorizationEndpoint: 'https://www.example.test/authorize',
    tokenEndpoint: 'https://www.example.test/token',
    supportsS256: true
  };

  function deps(overrides: Partial<Parameters<typeof signInToServer>[2]> = {}): {
    deps: Parameters<typeof signInToServer>[2];
    secrets: Record<string, string>;
    saved: string[];
    browserOpened: () => number;
  } {
    const secrets: Record<string, string> = {};
    const saved: string[] = [];
    let opened = 0;
    return {
      secrets,
      saved,
      browserOpened: () => opened,
      deps: {
        discover: async () => metadata,
        refresh: async () => ({ accessToken: 'renewed', refreshToken: 'next-time' }),
        login: async () => {
          opened++;
          return { clientId: 'issued', tokens: { accessToken: 'fresh', refreshToken: 'keep-me' }, metadata };
        },
        readSecret: (key) => secrets[key],
        writeSecret: (key, value) => { secrets[key] = value; },
        saveToken: (token) => { saved.push(token); return { ok: true }; },
        ...overrides
      }
    };
  }

  it('renews from a refresh token without opening anything', async () => {
    const harness = deps();
    harness.secrets[signInSecretKey('upwork', 'CLIENT')] = 'known';
    harness.secrets[signInSecretKey('upwork', 'REFRESH')] = 'still-good';

    const outcome = await signInToServer('upwork', 'https://mcp.example.test/mcp', harness.deps);

    expect(outcome).toMatchObject({ ok: true, renewed: true });
    expect(harness.saved).toEqual(['renewed']);
    expect(harness.browserOpened()).toBe(0);
    // The server may hand back a new one; keeping the old would spend a
    // credential the server has already replaced.
    expect(harness.secrets[signInSecretKey('upwork', 'REFRESH')]).toBe('next-time');
  });

  it('signs in properly when the refresh token is no longer honoured', async () => {
    const harness = deps({ refresh: async () => { throw new Error('invalid_grant'); } });
    harness.secrets[signInSecretKey('upwork', 'CLIENT')] = 'known';
    harness.secrets[signInSecretKey('upwork', 'REFRESH')] = 'expired';

    const outcome = await signInToServer('upwork', 'https://mcp.example.test/mcp', harness.deps);

    // Not an error: a dead refresh token means signing in again, which is
    // exactly what happened.
    expect(outcome).toMatchObject({ ok: true, renewed: false });
    expect(harness.browserOpened()).toBe(1);
    expect(harness.saved).toEqual(['fresh']);
  });

  it('opens a browser only when there is nothing to renew from', async () => {
    const harness = deps();

    const outcome = await signInToServer('upwork', 'https://mcp.example.test/mcp', harness.deps);

    expect(outcome.ok).toBe(true);
    expect(harness.browserOpened()).toBe(1);
    expect(harness.secrets[signInSecretKey('upwork', 'CLIENT')]).toBe('issued');
  });

  it('says plainly when no refresh token was issued at all', async () => {
    const harness = deps({
      login: async () => ({ clientId: 'issued', tokens: { accessToken: 'fresh' }, metadata })
    });

    const outcome = await signInToServer('upwork', 'https://mcp.example.test/mcp', harness.deps);

    expect(outcome.message).toContain('will ask again');
  });

  it('keeps the old refresh token when the server issues no new one', async () => {
    const harness = deps({ refresh: async () => ({ accessToken: 'renewed' }) });
    harness.secrets[signInSecretKey('upwork', 'CLIENT')] = 'known';
    harness.secrets[signInSecretKey('upwork', 'REFRESH')] = 'still-good';

    await signInToServer('upwork', 'https://mcp.example.test/mcp', harness.deps);

    expect(harness.secrets[signInSecretKey('upwork', 'REFRESH')]).toBe('still-good');
  });

  it('does not claim a renewal it could not store, and says so in plain words', async () => {
    const harness = deps({ saveToken: () => ({ ok: false }) });
    harness.secrets[signInSecretKey('upwork', 'CLIENT')] = 'known';
    harness.secrets[signInSecretKey('upwork', 'REFRESH')] = 'still-good';

    const outcome = await signInToServer('upwork', 'https://mcp.example.test/mcp', harness.deps);

    // A store that failed without saying why still owes the operator a sentence.
    expect(outcome).toMatchObject({ ok: false, renewed: true });
    expect(outcome.message).toBe('Could not store the renewed token.');
  });

  it('reports each step onward when someone is listening', async () => {
    const steps: string[] = [];
    const harness = deps({ onStep: (message) => steps.push(message) });
    harness.deps.login = async (_url, options) => {
      options.onStep?.('Opening your browser…');
      return { clientId: 'issued', tokens: { accessToken: 'fresh' }, metadata };
    };

    await signInToServer('upwork', 'https://mcp.example.test/mcp', harness.deps);

    expect(steps).toContain('Opening your browser…');
  });

  it('reports a refused sign-in in the words it was refused with', async () => {
    const harness = deps({ login: async () => { throw new Error('access_denied'); } });

    const outcome = await signInToServer('upwork', 'https://mcp.example.test/mcp', harness.deps);

    expect(outcome).toMatchObject({ ok: false, renewed: false });
    expect(outcome.message).toContain('access_denied');
  });

  it('does not claim success when the token could not be stored', async () => {
    const harness = deps({ saveToken: () => ({ ok: false, message: 'config is read-only' }) });

    const outcome = await signInToServer('upwork', 'https://mcp.example.test/mcp', harness.deps);

    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain('read-only');
  });
});

/**
 * The listener is on loopback, so anything on the machine can reach it.
 */
describe('what else reaches the callback listener', () => {
  it('answers a request to some other path without ending the wait', async () => {
    const port = await freePort();
    const server = fakeServer();
    let wrongPath = 0;

    const result = await loginToMcpServer('https://mcp.example.test/mcp', {
      port,
      timeoutMs: 3_000,
      fetchImpl: server.fetchImpl,
      openBrowserImpl: (url) => {
        const state = new URL(url).searchParams.get('state') ?? '';
        setTimeout(() => {
          // A stray probe: a browser asking for a favicon, or anything else on
          // the machine. It must not be mistaken for the redirect.
          void fetch(`http://localhost:${port}/favicon.ico`)
            .then((response) => { wrongPath = response.status; })
            .then(() => fetch(`http://localhost:${port}/callback?code=THE_CODE&state=${encodeURIComponent(state)}`))
            .catch(() => undefined);
        }, 20);
      }
    });

    expect(wrongPath).toBe(404);
    expect(result.tokens.accessToken).toBe('live-token');
  });

  it('says which port is taken instead of failing silently', async () => {
    const port = await freePort();
    const squatter = createServer();
    await new Promise<void>((resolve) => squatter.listen(port, '127.0.0.1', () => resolve()));

    try {
      await expect(loginToMcpServer('https://mcp.example.test/mcp', {
        port,
        timeoutMs: 3_000,
        fetchImpl: fakeServer().fetchImpl,
        openBrowserImpl: () => undefined
      })).rejects.toThrow(new RegExp(`Could not listen on port ${port}`));
    } finally {
      await new Promise<void>((resolve) => squatter.close(() => resolve()));
    }
  });
});

/**
 * Which command opens a browser where.
 *
 * The spawning itself is deliberately not exercised: a suite that opened a
 * browser window on the machine running it would be doing something to that
 * machine, and tests do not do that. The decision is what can be wrong, so the
 * decision is what is checked.
 */
describe('opening a browser for the operator', () => {
  it('uses the way each desktop opens a URL', () => {
    expect(browserCommandFor('https://x.test', 'win32'))
      .toEqual({ command: 'cmd', args: ['/c', 'start', '', 'https://x.test'] });
    expect(browserCommandFor('https://x.test', 'darwin'))
      .toEqual({ command: 'open', args: ['https://x.test'] });
    expect(browserCommandFor('https://x.test', 'linux'))
      .toEqual({ command: 'xdg-open', args: ['https://x.test'] });
  });

  it('detaches the child so closing the terminal does not close the browser', () => {
    const calls: Array<{ command: string; options: unknown }> = [];
    const child = { on: () => child, unref: () => undefined };
    const fakeSpawn = ((command: string, _args: string[], options: unknown) => {
      calls.push({ command, options });
      return child;
    }) as unknown as typeof import('node:child_process').spawn;

    openBrowser('https://x.test', fakeSpawn, 'linux');

    expect(calls).toHaveLength(1);
    expect(calls[0]?.options).toMatchObject({ detached: true, stdio: 'ignore' });
  });

  it('carries on when there is no browser to open', () => {
    const throwing = (() => { throw new Error('no display'); }) as unknown as typeof import('node:child_process').spawn;

    // A headless box, an SSH session, a locked-down desktop: the URL was
    // already printed, so there is nothing here to recover from.
    expect(() => openBrowser('https://x.test', throwing, 'linux')).not.toThrow();
  });
});
