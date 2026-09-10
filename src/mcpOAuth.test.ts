import { describe, expect, it } from 'vitest';
import {
  authorizationUrl,
  createPkce,
  createState,
  discoverAuthServer,
  exchangeCode,
  metadataCandidates,
  parseAuthChallenge,
  readRedirect,
  refreshTokens,
  registerClient,
  type AuthServerMetadata
} from './mcpOAuth';

/**
 * Signing in to a hosted MCP server without asking the operator for a token.
 *
 * The whole exchange is discoverable from a 401, and the one piece that looked
 * impossible turned out not to be: Upwork's registration endpoint is
 * `https://www.upwork.com/register`, which reads like a signup page for a
 * person and answers a registration request with `201 Created`. Reading the URL
 * and concluding there was no dynamic registration was wrong, and one request
 * settled it — hence the tests below drive the shapes rather than the names.
 */

const metadata: AuthServerMetadata = {
  issuer: 'https://mcp.example.test',
  authorizationEndpoint: 'https://www.example.test/oauth2/authorize',
  tokenEndpoint: 'https://www.example.test/api/oauth2/token',
  registrationEndpoint: 'https://www.example.test/register',
  supportsS256: true
};

function json(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body)
  } as unknown as Response;
}

describe('what a refused request tells us', () => {
  it('reads where the rules live out of the challenge', () => {
    const header = 'Bearer error="invalid_token", error_description="missing", ' +
      'resource_metadata="https://mcp.example.test/.well-known/oauth-protected-resource/mcp"';

    expect(parseAuthChallenge(header)).toEqual({
      resourceMetadata: 'https://mcp.example.test/.well-known/oauth-protected-resource/mcp'
    });
  });

  it('says nothing rather than guessing when the header carries no hint', () => {
    expect(parseAuthChallenge('Bearer realm="api"')).toEqual({});
    expect(parseAuthChallenge(null)).toEqual({});
    expect(parseAuthChallenge(undefined)).toEqual({});
  });

  it('looks at the path-qualified document before the bare one', () => {
    const candidates = metadataCandidates('https://mcp.example.test/mcp');

    expect(candidates[0]).toBe('https://mcp.example.test/.well-known/oauth-protected-resource/mcp');
    expect(candidates).toContain('https://mcp.example.test/.well-known/oauth-authorization-server');
    // One host may serve several protected resources, and the unqualified
    // document then describes only one of them.
    expect(candidates.indexOf('https://mcp.example.test/.well-known/oauth-protected-resource/mcp'))
      .toBeLessThan(candidates.indexOf('https://mcp.example.test/.well-known/oauth-protected-resource'));
  });

  it('puts the hinted document first, because the server named it itself', () => {
    const hinted = 'https://mcp.example.test/somewhere/else';

    expect(metadataCandidates('https://mcp.example.test/mcp', hinted)[0]).toBe(hinted);
  });
});

describe('following the trail to the endpoints', () => {
  it('reads a protected-resource document and then its authorization server', async () => {
    const asked: string[] = [];
    const fetchImpl = async (url: string): Promise<Response> => {
      asked.push(url);
      if (url.endsWith('/oauth-protected-resource/mcp')) {
        return json({ resource: 'https://mcp.example.test/mcp', authorization_servers: ['https://mcp.example.test'] });
      }
      if (url.endsWith('/oauth-authorization-server')) {
        return json({
          issuer: 'https://mcp.example.test',
          authorization_endpoint: 'https://www.example.test/oauth2/authorize',
          token_endpoint: 'https://www.example.test/api/oauth2/token',
          registration_endpoint: 'https://www.example.test/register',
          code_challenge_methods_supported: ['S256']
        });
      }
      return json({}, 404);
    };

    const found = await discoverAuthServer('https://mcp.example.test/mcp', { fetchImpl });

    expect(found).toMatchObject({
      authorizationEndpoint: 'https://www.example.test/oauth2/authorize',
      registrationEndpoint: 'https://www.example.test/register',
      supportsS256: true
    });
    expect(asked[0]).toContain('/oauth-protected-resource/mcp');
  });

  it('says so plainly when nothing there speaks OAuth', async () => {
    const fetchImpl = async (): Promise<Response> => json({}, 404);

    await expect(discoverAuthServer('https://mcp.example.test/mcp', { fetchImpl }))
      .rejects.toThrow(/No OAuth metadata/);
  });
});

describe('proving possession without a secret', () => {
  it('sends a hash and keeps the verifier', () => {
    const first = createPkce();
    const second = createPkce();

    expect(first.verifier).not.toBe(first.challenge);
    // A fresh pair every time: a reused verifier is a reusable authorization
    // code, which is the thing this exists to prevent.
    expect(first.verifier).not.toBe(second.verifier);
    expect(first.verifier.length).toBeGreaterThan(32);
    expect(first.challenge).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('registers as a client that cannot hold a secret', async () => {
    let sent: Record<string, unknown> = {};
    const fetchImpl = async (_url: string, init?: RequestInit): Promise<Response> => {
      sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return json({ client_id: 'abc123', token_endpoint_auth_method: 'none' }, 201);
    };

    const client = await registerClient(metadata, 'http://localhost:8765/callback', { fetchImpl });

    expect(client).toEqual({ clientId: 'abc123' });
    expect(sent.token_endpoint_auth_method).toBe('none');
    expect(sent.redirect_uris).toEqual(['http://localhost:8765/callback']);
    expect(sent.grant_types).toContain('refresh_token');
  });

  it('says what to do when the server does not hand out client ids', async () => {
    const { registrationEndpoint: _drop, ...withoutRegistration } = metadata;

    await expect(registerClient(withoutRegistration, 'http://localhost:8765/callback'))
      .rejects.toThrow(/issued to you by hand/);
  });
});

describe('the authorization request', () => {
  it('carries the challenge, the method and the resource it is for', () => {
    const url = new URL(authorizationUrl({
      metadata,
      clientId: 'abc123',
      redirectUri: 'http://localhost:8765/callback',
      challenge: 'CHALLENGE',
      state: 'STATE',
      resource: 'https://mcp.example.test/mcp'
    }));

    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('code_challenge')).toBe('CHALLENGE');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    // Bound to the resource, so a token issued here cannot be spent against
    // some other API on the same authorization server.
    expect(url.searchParams.get('resource')).toBe('https://mcp.example.test/mcp');
  });
});

describe('what comes back to the listener', () => {
  it('takes the code when the state matches', () => {
    expect(readRedirect('/callback?code=XYZ&state=STATE', 'STATE')).toEqual({ code: 'XYZ' });
  });

  it('ignores a redirect that belongs to some other request', () => {
    // A listener on localhost is open to whatever reaches it. Only the
    // redirect carrying this flow's own state is this flow's redirect.
    expect(() => readRedirect('/callback?code=XYZ&state=SOMEONE_ELSE', 'STATE'))
      .toThrow(/different state/);
  });

  it('reports a refusal in the words the server used', () => {
    expect(() => readRedirect('/callback?error=access_denied&error_description=User%20said%20no&state=STATE', 'STATE'))
      .toThrow(/access_denied — User said no/);
  });

  it('does not mistake an empty redirect for a success', () => {
    expect(() => readRedirect('/callback?state=STATE', 'STATE')).toThrow(/no authorization code/);
  });

  it('gives every attempt a state nobody could guess', () => {
    expect(createState()).not.toBe(createState());
    expect(createState().length).toBeGreaterThan(16);
  });
});

describe('turning a code into a token, and keeping it live', () => {
  it('sends the verifier the challenge was made from', async () => {
    let form = new URLSearchParams();
    const fetchImpl = async (_url: string, init?: RequestInit): Promise<Response> => {
      form = new URLSearchParams(String(init?.body));
      return json({ access_token: 'live', refresh_token: 'later', expires_in: 3600 });
    };

    const tokens = await exchangeCode({
      metadata, clientId: 'abc123', code: 'XYZ', verifier: 'VERIFIER',
      redirectUri: 'http://localhost:8765/callback', resource: 'https://mcp.example.test/mcp', fetchImpl
    });

    expect(tokens).toEqual({ accessToken: 'live', refreshToken: 'later', expiresIn: 3600 });
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('code_verifier')).toBe('VERIFIER');
    expect(form.get('client_id')).toBe('abc123');
  });

  it('renews without sending the operator back to a browser', async () => {
    let form = new URLSearchParams();
    const fetchImpl = async (_url: string, init?: RequestInit): Promise<Response> => {
      form = new URLSearchParams(String(init?.body));
      return json({ access_token: 'fresh' });
    };

    const tokens = await refreshTokens({
      metadata, clientId: 'abc123', refreshToken: 'later', fetchImpl
    });

    // A run that stops at midnight to ask for a login is a run that stopped.
    expect(tokens.accessToken).toBe('fresh');
    expect(form.get('grant_type')).toBe('refresh_token');
    expect(form.get('refresh_token')).toBe('later');
  });

  it('quotes the server when it refuses, rather than saying it failed', async () => {
    const fetchImpl = async (): Promise<Response> => json({ error: 'invalid_grant' }, 400);

    await expect(exchangeCode({
      metadata, clientId: 'abc123', code: 'XYZ', verifier: 'V',
      redirectUri: 'http://localhost:8765/callback', fetchImpl
    })).rejects.toThrow(/refused \(400\).*invalid_grant/);
  });

  it('refuses to call a missing access token a success', async () => {
    const fetchImpl = async (): Promise<Response> => json({ token_type: 'bearer' });

    await expect(refreshTokens({ metadata, clientId: 'abc123', refreshToken: 'later', fetchImpl }))
      .rejects.toThrow(/without an access token/);
  });
});
