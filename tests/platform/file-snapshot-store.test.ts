import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FileSnapshotStore } from '../../src/platform/file-snapshot-store.js';

describe('FileSnapshotStore', () => {
  let dir: string;
  let file: string;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-snap-'));
    file = path.join(dir, 'snap.json');
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('round trips text verbatim', async () => {
    const s = new FileSnapshotStore(file);
    await s.put('{"hello":"world"}');
    expect(await s.get()).toBe('{"hello":"world"}');
    expect(warn).not.toHaveBeenCalled();
  });

  it('does not parse or validate: garbage comes back as written', async () => {
    fs.writeFileSync(file, 'not json{');
    expect(await new FileSnapshotStore(file).get()).toBe('not json{');
    expect(warn).not.toHaveBeenCalled();
  });

  it('writes mode 0600 and leaves no tmp file', async () => {
    await new FileSnapshotStore(file).put('x');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('resets a pre-existing file with other perms to 0600', async () => {
    fs.writeFileSync(file, 'old');
    fs.chmodSync(file, 0o644);
    await new FileSnapshotStore(file).put('new');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('missing file is a silent miss', async () => {
    expect(await new FileSnapshotStore(file).get()).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it('a non-ENOENT read error (path is a directory) is a miss with a warning', async () => {
    expect(await new FileSnapshotStore(dir).get()).toBeUndefined();
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0][0])).toContain('could not read snapshot file');
  });

  it('missing directory: put resolves, warns, leaves nothing behind', async () => {
    const s = new FileSnapshotStore(path.join(dir, 'nope', 'snap.json'));
    await expect(s.put('x')).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('two concurrent puts leave one of the two texts and no tmp files', async () => {
    const s = new FileSnapshotStore(file);
    await Promise.all([s.put('a'.repeat(10_000)), s.put('b'.repeat(10_000))]);
    expect(['a'.repeat(10_000), 'b'.repeat(10_000)]).toContain(await s.get());
    expect(fs.readdirSync(dir)).toEqual(['snap.json']);
  });
});
