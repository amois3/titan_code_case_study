import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import type { SecretStore } from './store';

export class FileSecretStore implements SecretStore {
  readonly kind = 'file' as const;

  constructor(private readonly filePath: string) {}

  private ensureParent(): void {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  private readMap(): Record<string, string> {
    if (!existsSync(this.filePath)) return {};
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf-8')) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      const out: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value === 'string' && key.trim()) out[key] = value;
      }
      return out;
    } catch {
      return {};
    }
  }

  private writeMap(map: Record<string, string>): void {
    this.ensureParent();
    writeFileSync(this.filePath, JSON.stringify(map, null, 2), 'utf-8');
    try {
      chmodSync(this.filePath, 0o600);
    } catch {
      // Windows ACLs ignore mode bits; best-effort only.
    }
  }

  list(): string[] {
    return Object.keys(this.readMap()).sort();
  }

  get(key: string): string | undefined {
    return this.readMap()[key];
  }

  set(key: string, value: string): void {
    const map = this.readMap();
    map[key] = value;
    this.writeMap(map);
  }

  delete(key: string): boolean {
    const map = this.readMap();
    if (!(key in map)) return false;
    delete map[key];
    this.writeMap(map);
    return true;
  }

  all(): Record<string, string> {
    return this.readMap();
  }
}
