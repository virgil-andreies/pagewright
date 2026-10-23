/** Higher priority runs first: what the user is looking at, then pages about to be, then thumbnails. */
export type Priority = 'visible' | 'near' | 'thumbnail';

const RANK: Record<Priority, number> = { visible: 0, near: 1, thumbnail: 2 };

export class RenderCancelled extends Error {
  constructor(readonly key: string) {
    super(`Render cancelled: ${key}`);
    this.name = 'AbortError';
  }
}

export interface RenderJob<T> {
  /** Identity of the work, e.g. `page:3@1.5` or `thumb:3`. Enqueuing a key that is already queued or running joins it. */
  key: string;
  priority: Priority;
  /** Must stop early when `signal` aborts (pass it to `RenderDoc.renderPage`). */
  run(signal: AbortSignal): Promise<T>;
}

interface Entry {
  key: string;
  priority: Priority;
  seq: number;
  controller: AbortController;
  state: 'queued' | 'running' | 'done';
  start(): void;
  reject(e: unknown): void;
  promise: Promise<unknown>;
}

export interface RenderQueueOptions {
  /** Jobs running at once. Rendering is CPU/GPU bound; 2 is a good default. */
  concurrency?: number;
}

export class RenderQueue {
  private readonly concurrency: number;
  private readonly entries = new Map<string, Entry>();
  private running = 0;
  private seq = 0;

  constructor(o: RenderQueueOptions = {}) {
    this.concurrency = Math.max(1, o.concurrency ?? 2);
  }

  get pendingCount(): number {
    return [...this.entries.values()].filter((e) => e.state === 'queued').length;
  }

  get runningCount(): number {
    return this.running;
  }

  /**
   * Queues a job. `signal` cancels only this caller's interest: the job itself is cancelled when
   * the last interested caller aborts or when `cancel(key)` is called.
   */
  enqueue<T>(job: RenderJob<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(new RenderCancelled(job.key));
    this.interest.set(job.key, (this.interest.get(job.key) ?? 0) + 1);
    const existing = this.entries.get(job.key);
    if (existing && existing.state !== 'done') {
      this.reprioritize(job.key, job.priority);
      return this.watch(existing.promise as Promise<T>, job.key, signal);
    }

    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
    const entry: Entry = {
      key: job.key,
      priority: job.priority,
      seq: this.seq++,
      controller: new AbortController(),
      state: 'queued',
      promise,
      reject,
      start: () => {
        entry.state = 'running';
        this.running++;
        job.run(entry.controller.signal).then(
          (v) => (entry.controller.signal.aborted ? reject(new RenderCancelled(job.key)) : resolve(v)),
          reject,
        ).finally(() => {
          entry.state = 'done';
          this.running--;
          if (this.entries.get(job.key) === entry) {
            this.entries.delete(job.key);
            this.interest.delete(job.key);
          }
          this.pump();
        });
      },
    };
    // A cancelled job rejects its promise; callers who dropped interest must not see an unhandled rejection.
    promise.catch(() => {});
    this.entries.set(job.key, entry);
    this.pump();
    return this.watch(promise, job.key, signal);
  }

  /** E.g. a thumbnail scrolled into view becomes `visible`. Priorities only ever move up while queued. */
  reprioritize(key: string, priority: Priority): void {
    const e = this.entries.get(key);
    if (e && e.state === 'queued' && RANK[priority] < RANK[e.priority]) e.priority = priority;
  }

  /** Cancels queued or running work for `key`. */
  cancel(key: string): void {
    const e = this.entries.get(key);
    if (!e || e.state === 'done') return;
    e.controller.abort();
    e.reject(new RenderCancelled(key));
    this.interest.delete(key);
    this.entries.delete(key); // a later enqueue of the same key starts fresh
    if (e.state === 'queued') e.state = 'done';
  }

  /** Cancels every job whose key matches, e.g. all work for a page that left the window. */
  cancelWhere(match: (key: string) => boolean): void {
    for (const key of [...this.entries.keys()]) if (match(key)) this.cancel(key);
  }

  private watch<T>(promise: Promise<T>, key: string, signal?: AbortSignal): Promise<T> {
    if (!signal) return promise;
    if (signal.aborted) {
      this.release(key);
      return Promise.reject(new RenderCancelled(key));
    }
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        this.release(key);
        reject(new RenderCancelled(key));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
    });
  }

  private readonly interest = new Map<string, number>();

  /** Ref-counting so one caller aborting does not cancel a job another caller still awaits. */
  private release(key: string): void {
    const left = (this.interest.get(key) ?? 0) - 1;
    if (left <= 0) {
      this.interest.delete(key);
      this.cancel(key);
    } else {
      this.interest.set(key, left);
    }
  }

  private pump(): void {
    while (this.running < this.concurrency) {
      let next: Entry | undefined;
      for (const e of this.entries.values()) {
        if (e.state !== 'queued') continue;
        if (!next || RANK[e.priority] < RANK[next.priority] || (e.priority === next.priority && e.seq < next.seq)) next = e;
      }
      if (!next) return;
      next.start();
    }
  }
}

// ---- Canvas pooling --------------------------------------------------------------------

export interface Sized {
  width: number;
  height: number;
}

export interface CanvasPoolOptions<C extends Sized> {
  create(): C;
  /** Called on release so pooled canvases do not hold large backing stores. Defaults to shrinking to 0x0. */
  reset?(c: C): void;
  maxIdle?: number;
}

export class CanvasPool<C extends Sized> {
  private readonly idle: C[] = [];
  private readonly maxIdle: number;

  constructor(private readonly o: CanvasPoolOptions<C>) {
    this.maxIdle = o.maxIdle ?? 4;
  }

  acquire(): C {
    return this.idle.pop() ?? this.o.create();
  }

  release(c: C): void {
    if (this.idle.length >= this.maxIdle) {
      this.reset(c); // drop the backing store; let the GC take the element
      return;
    }
    this.reset(c);
    this.idle.push(c);
  }

  get idleCount(): number {
    return this.idle.length;
  }

  private reset(c: C): void {
    if (this.o.reset) this.o.reset(c);
    else (c.width = 0), (c.height = 0);
  }
}

/**
 * Keeps one canvas per page key and drops the ones that fall outside the viewport window
 * (current page +/- `radius`, spec section 5.1) back into the pool.
 */
export class CanvasWindow<C extends Sized> {
  private readonly leased = new Map<number, C>();

  constructor(private readonly pool: CanvasPool<C>, private readonly radius = 2) {}

  get(pageIndex: number): C {
    let c = this.leased.get(pageIndex);
    if (!c) this.leased.set(pageIndex, (c = this.pool.acquire()));
    return c;
  }

  has(pageIndex: number): boolean {
    return this.leased.has(pageIndex);
  }

  /** Call when the current page changes. Returns the indices that were released. */
  moveTo(current: number): number[] {
    const dropped: number[] = [];
    for (const [i, c] of this.leased) {
      if (Math.abs(i - current) > this.radius) {
        this.pool.release(c);
        this.leased.delete(i);
        dropped.push(i);
      }
    }
    return dropped;
  }

  get size(): number {
    return this.leased.size;
  }
}
