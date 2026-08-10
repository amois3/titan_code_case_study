import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileSecretStore } from './fileStore';
import { applySecretsToEnv, describeSecretBackend, getSecretStore, resetSecretStoreCache } from './index';

const roots: string[] = [];

describe('FileSecretStore', () => {

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

/**
 * The file holds an API key. Everything about how it is read matters: a file
 * somebody hand-edited, a value that is not a string, a directory that does
 * not exist yet. None of those may lose the rest of the keys or throw on
 * startup.
 */
describe('a secrets file written by something other than this program', () => {
  function store() {
    const root = mkdtempSync(join(tmpdir(), 'titan-secrets-'));
    roots.push(root);
    const path = join(root, 'nested', 'secrets.json');
    return { path, store: new FileSecretStore(path) };
  }

  it('creates the directory it was pointed at', () => {
    const { path, store: secrets } = store();
    secrets.set('KEY', 'value');

    expect(existsSync(path)).toBe(true);
    expect(secrets.get('KEY')).toBe('value');
  });

  it('reads a file that is not there as an empty one', () => {
    const { store: secrets } = store();

    expect(secrets.list()).toEqual([]);
    expect(secrets.get('KEY')).toBeUndefined();
    expect(secrets.delete('KEY')).toBe(false);
  });

  it('reads a file that is not JSON as an empty one rather than throwing', () => {
    const { path, store: secrets } = store();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, 'not json at all', 'utf-8');

    expect(secrets.list()).toEqual([]);
  });

  it('ignores entries that are not strings, and keeps the ones that are', () => {
    const { path, store: secrets } = store();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ GOOD: 'value', BAD: 42, WORSE: null, '': 'blank name' }), 'utf-8');

    expect(secrets.list()).toEqual(['GOOD']);
  });

  it('reads a file holding a list as an empty one', () => {
    const { path, store: secrets } = store();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '["not", "a", "map"]', 'utf-8');

    expect(secrets.list()).toEqual([]);
  });

  it('keeps the other keys when one is removed', () => {
    const { store: secrets } = store();
    secrets.set('FIRST', 'one');
    secrets.set('SECOND', 'two');

    expect(secrets.delete('FIRST')).toBe(true);
    expect(secrets.list()).toEqual(['SECOND']);
  });

  it('says what backend it is, for the operator to check', () => {
    const { store: secrets } = store();

    expect(secrets.kind).toBe('file');
    expect(describeSecretBackend(secrets)).toContain('600');
  });
});
