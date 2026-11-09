export type NarrationItem = { key: string; text: string };
export type PreparedNarration = { url: string; bytes: number };
type CacheOptions = {
  maxBytes?: number;
  createUrl?: (blob: Blob) => string;
  revokeUrl?: (url: string) => void;
};

const DEFAULT_MAX_BYTES = 192 * 1024 * 1024;

/** A bounded whole-lesson cache. Pausing playback never owns these requests. */
export class NarrationCache {
  private entries = new Map<string, PreparedNarration>();
  private bytes = 0;
  private controller: AbortController | null = null;
  private maxBytes: number;
  private createUrl: (blob: Blob) => string;
  private revokeUrl: (url: string) => void;

  constructor(options: CacheOptions = {}) {
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.createUrl = options.createUrl ?? ((blob) => URL.createObjectURL(blob));
    this.revokeUrl = options.revokeUrl ?? ((url) => URL.revokeObjectURL(url));
  }

  get(key: string) {
    const entry = this.entries.get(key);
    if (entry) {
      this.entries.delete(key);
      this.entries.set(key, entry);
    }
    return entry;
  }

  has(key: string) {
    return this.entries.has(key);
  }

  count(items: NarrationItem[]) {
    return items.filter((item) => this.entries.has(item.key)).length;
  }

  remove(key: string) {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.bytes -= entry.bytes;
    this.revokeUrl(entry.url);
  }

  cancel() {
    this.controller?.abort();
    this.controller = null;
  }

  clear() {
    this.cancel();
    for (const entry of this.entries.values()) this.revokeUrl(entry.url);
    this.entries.clear();
    this.bytes = 0;
  }

  async prepare(
    items: NarrationItem[],
    load: (text: string, signal: AbortSignal) => Promise<Blob>,
    onProgress: (completed: number) => void,
    priority?: (item: NarrationItem) => number,
  ) {
    this.cancel();
    const controller = new AbortController();
    this.controller = controller;
    const protectedKeys = new Set(items.map((item) => item.key));
    const queued = [...new Map(items.map((item) => [item.key, item])).values()].filter(
      (item) => !this.entries.has(item.key),
    );
    let firstError: unknown;
    onProgress(this.count(items));
    const worker = async () => {
      while (!controller.signal.aborted) {
        let next = 0;
        if (priority) {
          for (let index = 1; index < queued.length; index += 1)
            if (priority(queued[index]) < priority(queued[next])) next = index;
        }
        const [item] = queued.splice(next, 1);
        if (!item) return;
        try {
          const blob = await load(item.text, controller.signal);
          controller.signal.throwIfAborted();
          // Evict completed audio from other lessons, never the lesson being prepared.
          for (const key of this.entries.keys()) {
            if (this.bytes + blob.size <= this.maxBytes) break;
            if (!protectedKeys.has(key)) this.remove(key);
          }
          if (this.bytes + blob.size > this.maxBytes)
            throw new Error('这节课的语音超过 192 MB 缓存上限，请拆成较短的课程或仅看字幕。');
          const entry = { url: this.createUrl(blob), bytes: blob.size };
          this.entries.set(item.key, entry);
          this.bytes += entry.bytes;
          onProgress(this.count(items));
        } catch (error) {
          if (!controller.signal.aborted) {
            firstError = error;
            controller.abort();
          }
          return;
        }
      }
    };
    await Promise.all([worker(), worker()]);
    if (this.controller === controller) this.controller = null;
    if (firstError) throw firstError;
    controller.signal.throwIfAborted();
  }
}
