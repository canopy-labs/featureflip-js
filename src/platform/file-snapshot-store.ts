import * as fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import type { SnapshotStore } from '../core/snapshot-store.js';

/**
 * Persists the SDK's snapshot text to one file (mode 0600), written atomically
 * via a temp file + rename. The store is opaque: it neither parses nor checks
 * what it holds (the SDK validates the text on read), so one instance can be
 * shared by several SDK keys. Never throws: failures are warned and treated as
 * a miss (get) or a dropped write (put). The parent directory must already exist.
 *
 * There is deliberately no fsync before the rename, so a power loss can leave a
 * zero-length or partial file. The SDK reads that as `snapshot-invalid`, logs a
 * warning and serves defaults; the next successful write replaces it.
 */
export class FileSnapshotStore implements SnapshotStore {
  constructor(private readonly path: string) {}

  async get(): Promise<string | undefined> {
    try {
      return await fs.promises.readFile(this.path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined;
      console.warn(`[featureflip] could not read snapshot file ${this.path}:`, err);
      return undefined;
    }
  }

  async put(text: string): Promise<void> {
    const tmp = `${this.path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await fs.promises.writeFile(tmp, text, { mode: 0o600, flag: 'wx' });
      await fs.promises.rename(tmp, this.path);
    } catch (err) {
      console.warn(`[featureflip] could not write snapshot file ${this.path}:`, err);
      await fs.promises.rm(tmp, { force: true }).catch(() => {});
    }
  }
}
