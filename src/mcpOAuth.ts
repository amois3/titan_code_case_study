// mcpOAuth.ts - signing in to a hosted MCP server that asks for OAuth.
//
// A hosted server answers an unauthenticated request with 401 and a
// `WWW-Authenticate` header naming where its rules live. From there the whole
// exchange is discoverable: the resource metadata names its authorization
// server, that server's metadata names the endpoints, and — where it offers
// one — a registration endpoint hands out a client id to a program that has
// never been seen before.
//
// That last part is what makes this worth writing rather than asking the
// operator to paste a token. Upwork's registration endpoint is
// `https://www.upwork.com/register`, which reads like a signup page for a
// person and answers a registration request with `201 Created` and a client
// id. Reading the URL and concluding there was no dynamic registration cost an
// afternoon; one POST settled it.
//
// No client secret is stored. A command-line tool cannot keep one, so it
// registers as a public client and proves itself with PKCE instead: a random
// verifier held in memory, its SHA-256 sent up front, and the code useless to
// anyone who intercepts it without the verifier.

import { createHash, randomBytes } from 'node:crypto';

/** What the server said when it refused an unauthenticated request. */
export interface AuthChallenge {
  /** Where the protected-resource metadata lives, when the header names it. */
  resourceMetadata?: string;
}

/**
 * Read the `WWW-Authenticate` header of a 401.
 *
 * Only the pieces this flow needs are taken. The header is a list of key="value"
 * pairs after the scheme, and a server may include others — an error code, a
 * description — which are for the operator to read rather than for this to act
 * on.
 */
export function parseAuthChallenge(header: string | null | undefined): AuthChallenge {
  if (!header) return {};
  const metadata = /resource_metadata\s*=\s*"([^"]+)"/i.exec(header)?.[1];
  return metadata ? { resourceMetadata: metadata } : {};
}

export interface AuthServerMetadata {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  /** Absent on servers that do not publish it; S256 is required either way. */
  supportsS256: boolean;
}

interface RawAuthServerMetadata {
  issuer?: unknown;
  authorization_endpoint?: unknown;
  token_endpoint?: unknown;
  registration_endpoint?: unknown;
  code_challenge_methods_supported?: unknown;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** The well-known paths a resource's authorization server may be described at. */
export function metadataCandidates(resourceUrl: string, hinted?: string): string[] {
  const candidates: string[] = [];
  if (hinted) candidates.push(hinted);
  try {
    const url = new URL(resourceUrl);
    const path = url.pathname.replace(/\/+$/, '');
    // Path-qualified first: one host may serve several protected resources, and
    // the unqualified document then describes only one of them.
    if (path) candidates.push(`${url.origin}/.well-known/oauth-protected-resource${path}`);
    candidates.push(`${url.origin}/.well-known/oauth-protected-resource`);
    if (path) candidates.push(`${url.origin}/.well-known/oauth-authorization-server${path}`);
    candidates.push(`${url.origin}/.well-known/oauth-authorization-server`);
  } catch {
    // A resource URL this malformed cannot be discovered from; the caller sees
    // an empty list and reports that rather than throwing here.
  }
  return [...new Set(candidates)];
}

function readAuthServerMetadata(raw: RawAuthServerMetadata): AuthServerMetadata | undefined {
  const authorizationEndpoint = text(raw.authorization_endpoint);
  const tokenEndpoint = text(raw.token_endpoint);
  if (!authorizationEndpoint || !tokenEndpoint) return undefined;
  const methods = Array.isArray(raw.code_challenge_methods_supported)
    ? raw.code_challenge_methods_supported.map((value) => String(value))
    : [];
  return {
    issuer: text(raw.issuer) ?? new URL(authorizationEndpoint).origin,
    authorizationEndpoint,
    tokenEndpoint,
    ...(text(raw.registration_endpoint) ? { registrationEndpoint: text(raw.registration_endpoint)! } : {}),
    supportsS256: methods.length === 0 || methods.includes('S256')
  };
}

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Follow the trail from a resource URL to the endpoints that authorize it.
 *
 * A protected-resource document names its authorization servers; an
 * authorization-server document names the endpoints. Either may answer at
 * either well-known path, so each candidate is read and whichever shape comes
 * back is used.
 */
export async function discoverAuthServer(
  resourceUrl: string,
  options: { hinted?: string; fetchImpl?: Fetch } = {}
): Promise<AuthServerMetadata> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const seen = new Set<string>();
  const queue = metadataCandidates(resourceUrl, options.hinted);

  for (let index = 0; index < queue.length && index < 8; index++) {
    const candidate = queue[index]!;
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    let raw: Record<string, unknown>;
    try {
      const response = await fetchImpl(candidate, { headers: { accept: 'application/json' } });
      if (!response.ok) continue;
      raw = await response.json() as Record<string, unknown>;
    } catch {
      continue;
    }

    const direct = readAuthServerMetadata(raw as RawAuthServerMetadata);
    if (direct) return direct;

    // A protected-resource document: it points at the servers rather than
    // being one, so their metadata is queued behind what is already listed.
    const servers = Array.isArray(raw.authorization_servers) ? raw.authorization_servers : [];
    for (const server of servers) {
      const issuer = text(server);
      if (!issuer) continue;
      queue.push(`${issuer.replace(/\/+$/, '')}/.well-known/oauth-authorization-server`);
      queue.push(`${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`);
    }
  }

  throw new Error(`No OAuth metadata was found for ${resourceUrl}. The server may not use OAuth, or may publish it somewhere this does not look.`);
}

export interface Pkce {
  verifier: string;
  challenge: string;
}

/**
 * A fresh proof-of-possession pair.
 *
 * The verifier never leaves this process; only its hash is sent with the
 * authorization request. An authorization code stolen from the redirect is
 * then worth nothing, which is the whole reason a public client may do this
 * without a secret.
 */
export function createPkce(): Pkce {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

export interface RegisteredClient {
  clientId: string;
  /** Present only where the server insists on one; a CLI cannot keep it safe. */
  clientSecret?: string;
}

/**
 * Ask the authorization server for a client id, as a program it has never met.
 *
 * `token_endpoint_auth_method: none` says plainly what this is: a public
 * client that cannot hold a secret. A server that answers with one anyway has
 * been asked not to, and the caller decides whether to keep it.
 */
export async function registerClient(
  metadata: AuthServerMetadata,
  redirectUri: string,
  options: { clientName?: string; fetchImpl?: Fetch } = {}
): Promise<RegisteredClient> {
  if (!metadata.registrationEndpoint) {
    throw new Error('This server does not offer dynamic registration, so it needs a client id issued to you by hand.');
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(metadata.registrationEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      client_name: options.clientName ?? 'titan-code',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none'
    })
  });
  if (!response.ok) {
    throw new Error(`Registration was refused (${response.status}). ${(await response.text()).slice(0, 200)}`);
  }
  const body = await response.json() as { client_id?: unknown; client_secret?: unknown };
  const clientId = text(body.client_id);
  if (!clientId) throw new Error('Registration answered without a client id.');
  const clientSecret = text(body.client_secret);
  return { clientId, ...(clientSecret ? { clientSecret } : {}) };
}

/** Where to send the operator's browser, and what to expect back. */
export function authorizationUrl(input: {
  metadata: AuthServerMetadata;
  clientId: string;
  redirectUri: string;
  challenge: string;
  state: string;
  /** The MCP endpoint this token is for; bound so it cannot be spent elsewhere. */
  resource?: string;
  scope?: string;
}): string {
  const url = new URL(input.metadata.authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', input.clientId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('code_challenge', input.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', input.state);
  if (input.resource) url.searchParams.set('resource', input.resource);
  if (input.scope) url.searchParams.set('scope', input.scope);
  return url.toString();
}

export interface Tokens {
  accessToken: string;
  refreshToken?: string;
  /** Seconds from now, where the server said; absent means it did not. */
  expiresIn?: number;
}

function readTokens(body: Record<string, unknown>): Tokens {
  const accessToken = text(body.access_token);
  if (!accessToken) throw new Error('The token endpoint answered without an access token.');
  const refreshToken = text(body.refresh_token);
  const expires = typeof body.expires_in === 'number' ? body.expires_in : undefined;
  return {
    accessToken,
    ...(refreshToken ? { refreshToken } : {}),
    ...(expires === undefined ? {} : { expiresIn: expires })
  };
}

async function postToken(
  metadata: AuthServerMetadata,
  form: Record<string, string>,
  fetchImpl: Fetch
): Promise<Tokens> {
  const response = await fetchImpl(metadata.tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(form).toString()
  });
  if (!response.ok) {
    throw new Error(`The token endpoint refused (${response.status}). ${(await response.text()).slice(0, 200)}`);
  }
  return readTokens(await response.json() as Record<string, unknown>);
}

export async function exchangeCode(input: {
  metadata: AuthServerMetadata;
  clientId: string;
  clientSecret?: string;
  code: string;
  verifier: string;
  redirectUri: string;
  resource?: string;
  fetchImpl?: Fetch;
}): Promise<Tokens> {
  return postToken(input.metadata, {
    grant_type: 'authorization_code',
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: input.clientId,
    code_verifier: input.verifier,
    ...(input.clientSecret ? { client_secret: input.clientSecret } : {}),
    ...(input.resource ? { resource: input.resource } : {})
  }, input.fetchImpl ?? fetch);
}

/**
 * Trade a refresh token for a live one.
 *
 * Done rather than sending the operator back to a browser: a run that stops at
 * midnight to ask for a login is a run that has stopped.
 */
export async function refreshTokens(input: {
  metadata: AuthServerMetadata;
  clientId: string;
  clientSecret?: string;
  refreshToken: string;
  resource?: string;
  fetchImpl?: Fetch;
}): Promise<Tokens> {
  return postToken(input.metadata, {
    grant_type: 'refresh_token',
    refresh_token: input.refreshToken,
    client_id: input.clientId,
    ...(input.clientSecret ? { client_secret: input.clientSecret } : {}),
    ...(input.resource ? { resource: input.resource } : {})
  }, input.fetchImpl ?? fetch);
}

/** A random, unguessable value tying the redirect back to the request that started it. */
export function createState(): string {
  return randomBytes(16).toString('base64url');
}

/**
 * Read the code out of the redirect the browser was sent to.
 *
 * The state is checked here rather than by the caller, because a redirect that
 * does not match the request that started it is not this flow's redirect —
 * it is somebody else's, arriving at a listener that happens to be open.
 */
export function readRedirect(rawUrl: string, expectedState: string): { code: string } {
  let url: URL;
  try {
    url = new URL(rawUrl, 'http://localhost');
  } catch {
    throw new Error('The redirect was not a URL this could read.');
  }
  const error = url.searchParams.get('error');
  if (error) {
    const description = url.searchParams.get('error_description');
    throw new Error(`Authorization was refused: ${error}${description ? ` — ${description}` : ''}`);
  }
  if (url.searchParams.get('state') !== expectedState) {
    throw new Error('The redirect carried a different state than the request that started it, so it was ignored.');
  }
  const code = url.searchParams.get('code');
  if (!code) throw new Error('The redirect carried no authorization code.');
  return { code };
}
