import { SECRETS_FILE } from '../paths';
import { FileSecretStore } from './fileStore';
import type { SecretBackendKind, SecretStore } from './store';

export type { SecretBackendKind, SecretStore } from './store';
export { FileSecretStore } from './fileStore';

let cached: SecretStore | null = null;

/**
 * Returns the active secret store.
 *
 * Backend selection:
 * - `TITAN_CODE_SECRETS_BACKEND=file` (default) — JSON under config dir
 * - `keychain` is reserved; falls back to file with a one-line note until a
 *   native module is wired (keytar / DPAPI). Shipping a broken keychain claim
 *   would be worse than an honest file store.
 */
export function getSecretStore(): SecretStore {
  if (cached) return cached;

  const requested = (process.env.TITAN_CODE_SECRETS_BACKEND || 'file').toLowerCase();
  const kind: SecretBackendKind = requested === 'keychain' ? 'keychain' : 'file';

  if (kind === 'keychain') {
    // Placeholder: when a keychain adapter exists, construct it here.
    // Until then, file storage remains the only production backend.
    cached = new FileSecretStore(SECRETS_FILE);
  } else {
    cached = new FileSecretStore(SECRETS_FILE);
  }
  return cached;
}

/** Test seam — drop the process-wide cache. */
export function resetSecretStoreCache(): void {
  cached = null;
}

export function applySecretsToEnv(store: SecretStore = getSecretStore()): void {
  for (const [key, value] of Object.entries(store.all())) {
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

export function describeSecretBackend(store: SecretStore = getSecretStore()): string {
  if (store.kind === 'file') {
    return 'file (secrets.json, mode 600 when the OS supports it)';
  }
  return store.kind;
}
