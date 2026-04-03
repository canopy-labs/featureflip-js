import type { FlagDto, SegmentDto } from './types.js';

export type FlagChangeListener = (key: string) => void;

export class FlagStore {
  private flags = new Map<string, FlagDto>();
  private segments = new Map<string, SegmentDto>();
  private listeners: FlagChangeListener[] = [];
  private version = 0;

  getFlag(key: string): FlagDto | undefined {
    return this.flags.get(key);
  }

  getSegment(key: string): SegmentDto | undefined {
    return this.segments.get(key);
  }

  getAllFlags(): FlagDto[] {
    return Array.from(this.flags.values());
  }

  getVersion(): number {
    return this.version;
  }

  init(flags: FlagDto[], segments: SegmentDto[], version: number): void {
    this.flags.clear();
    this.segments.clear();
    for (const flag of flags) {
      this.flags.set(flag.key, flag);
    }
    for (const segment of segments) {
      this.segments.set(segment.key, segment);
    }
    this.version = version;
    for (const flag of flags) {
      this.notifyListeners(flag.key);
    }
  }

  upsert(flag: FlagDto): void {
    const existing = this.flags.get(flag.key);
    if (existing && existing.version >= flag.version) {
      return;
    }
    this.flags.set(flag.key, flag);
    this.notifyListeners(flag.key);
  }

  delete(key: string): void {
    if (this.flags.delete(key)) {
      this.notifyListeners(key);
    }
  }

  onChange(listener: FlagChangeListener): () => void {
    this.listeners.push(listener);
    return () => {
      const idx = this.listeners.indexOf(listener);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }

  private notifyListeners(key: string): void {
    for (const listener of this.listeners) {
      try {
        listener(key);
      } catch {
        // Swallow listener errors
      }
    }
  }
}
