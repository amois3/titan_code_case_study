/**
 * Storage for API keys and other secrets.
 *
 * The default backend is a chmod-600 JSON file under the titan-code config
 * directory. A keychain/DPAPI backend can plug in later behind the same
 * interface without changing /secrets command UX.
 */

export type SecretBackendKind = 'file' | 'keychain';

export interface SecretStore {
  readonly kind: SecretBackendKind;
  list(): string[];
  get(key: string): string | undefined;
  set(key: string, value: string): void;
  delete(key: string): boolean;
  /** Load all secrets as a plain map (for apply-to-env). */
  all(): Record<string, string>;
}
