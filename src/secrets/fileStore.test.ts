import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileSecretStore } from './fileStore';
import { applySecretsToEnv, getSecretStore, resetSecretStoreCache } from './index';

describe('FileSecretStore', () => {
  const roots: string[] = [];

  afterEach(() => {
    resetSecretStoreCache();
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
    delete process.env.TITAN_CODE_TEST_SECRET;
  });

  it('round-trips set/list/get/delete', () => {
    const root = mkdtempSync(join(tmpdir(), 'titan-secrets-'));
    roots.push(root);
    const store = new FileSecretStore(join(root, 'secrets.json'));

    store.set('OPENROUTER_API_KEY', 'sk-test');
    expect(store.list()).toEqual(['OPENROUTER_API_KEY']);
    expect(store.get('OPENROUTER_API_KEY')).toBe('sk-test');
    expect(store.delete('OPENROUTER_API_KEY')).toBe(true);
    expect(store.list()).toEqual([]);
  });

  it('applies secrets to env without overwriting existing vars', () => {
    const root = mkdtempSync(join(tmpdir(), 'titan-secrets-'));
    roots.push(root);
    const store = new FileSecretStore(join(root, 'secrets.json'));
    store.set('TITAN_CODE_TEST_SECRET', 'from-file');
    process.env.TITAN_CODE_TEST_SECRET = 'from-env';
    applySecretsToEnv(store);
    expect(process.env.TITAN_CODE_TEST_SECRET).toBe('from-env');
    delete process.env.TITAN_CODE_TEST_SECRET;
    applySecretsToEnv(store);
    expect(process.env.TITAN_CODE_TEST_SECRET).toBe('from-file');
  });

  it('returns a process store via getSecretStore', () => {
    const store = getSecretStore();
    expect(store.kind).toBe('file');
    expect(Array.isArray(store.list())).toBe(true);
  });
});
