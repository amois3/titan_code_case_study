import { SECRETS_FILE } from '../paths';
import { FileSecretStore } from './fileStore';
import type { SecretStore } from './store';

export type { SecretBackendKind, SecretStore } from './store';
export { FileSecretStore } from './fileStore';

let cached: SecretStore | null = null;

/**
 * Returns the active secret store.
 *
 * There is one backend: JSON under the config directory, mode 600 where the OS
 * honours it. A keychain adapter (keytar / DPAPI) can be added behind the same
 * interface, and until one exists there is nothing to select between —
 * announcing a choice that resolves to the same store either way reads as
 * encryption the product does not provide.
 */
export function getSecretStore(): SecretStore {
  if (cached) return cached;

  // `keychain` used to take its own branch, which constructed exactly the same
  // file store as the other one. Two spellings of one behaviour read as a
  // choice that exists; there is one backend until a native adapter is wired.
  cached = new FileSecretStore(SECRETS_FILE);
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
