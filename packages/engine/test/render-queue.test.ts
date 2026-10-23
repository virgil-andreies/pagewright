import { describe, expect, it } from 'vitest';
import { CanvasPool, CanvasWindow, RenderCancelled, RenderQueue, type Priority } from '../src';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

/** A job that records when it starts and finishes only when released (or aborted). */
function job(key: string, priority: Priority, log: string[]) {
  const gate = deferred();
  return {
    gate,
    job: {
      key,
      priority,
      async run(signal: AbortSignal) {
        log.push(`start ${key}`);
        await Promise.race([
          gate.promise,
          new Promise((_, rej) => signal.addEventListener('abort', () => rej(new Error('aborted')), { once: true })),
        ]);
        log.push(`end ${key}`);
        return key;
      },
    },
  };
}

const started = (log: string[]) => log.filter((l) => l.startsWith('start')).map((l) => l.slice(6));

describe('RenderQueue', () => {
  it('runs by priority, then FIFO, within the concurrency limit', async () => {
    const q = new RenderQueue({ concurrency: 1 });
    const log: string[] = [];
    const first = job('first', 'thumbnail', log);
    const t = job('thumb', 'thumbnail', log);
    const n = job('near', 'near', log);
    const v = job('visible', 'visible', log);
    const all = [first, t, n, v].map((j) => q.enqueue(j.job));
    await tick();
    expect(log).toEqual(['start first']);
    for (const j of [first, v, n, t]) {
      j.gate.resolve();
      await tick();
    }
    await Promise.all(all);
    expect(started(log)).toEqual(['first', 'visible', 'near', 'thumb']);
  });

  it('never exceeds the concurrency limit', async () => {
    const q = new RenderQueue({ concurrency: 2 });
    const log: string[] = [];
    const jobs = ['a', 'b', 'c', 'd'].map((k) => job(k, 'near', log));
    jobs.forEach((j) => void q.enqueue(j.job));
    await tick();
    expect(q.runningCount).toBe(2);
    expect(q.pendingCount).toBe(2);
    jobs[0]!.gate.resolve();
    await tick();
    expect(q.runningCount).toBe(2);
    expect(log).toContain('start c');
  });

  it('cancelling a queued job rejects it and it never starts', async () => {
    const q = new RenderQueue({ concurrency: 1 });
    const log: string[] = [];
    const a = job('a', 'near', log);
    const b = job('b', 'near', log);
    void q.enqueue(a.job);
    const pb = q.enqueue(b.job);
    q.cancel('b');
    await expect(pb).rejects.toBeInstanceOf(RenderCancelled);
    a.gate.resolve();
    await tick();
    expect(log).not.toContain('start b');
  });

  it('aborting a running job signals it and frees the slot', async () => {
    const q = new RenderQueue({ concurrency: 1 });
    const log: string[] = [];
    const a = job('a', 'near', log);
    const b = job('b', 'near', log);
    const ac = new AbortController();
    const pa = q.enqueue(a.job, ac.signal);
    void q.enqueue(b.job);
    await tick();
    ac.abort();
    await expect(pa).rejects.toBeInstanceOf(RenderCancelled);
    await tick();
    expect(log).toContain('start b');
  });

  it('an already-aborted signal rejects without running', async () => {
    const q = new RenderQueue();
    const log: string[] = [];
    const ac = new AbortController();
    ac.abort();
    await expect(q.enqueue(job('a', 'near', log).job, ac.signal)).rejects.toBeInstanceOf(RenderCancelled);
    await tick();
    expect(log).toEqual([]);
  });

  it('joins duplicate keys and runs once; one caller aborting does not cancel the other', async () => {
    const q = new RenderQueue();
    const log: string[] = [];
    const a = job('a', 'thumbnail', log);
    const ac = new AbortController();
    const p1 = q.enqueue(a.job, ac.signal);
    const p2 = q.enqueue(a.job);
    ac.abort();
    await expect(p1).rejects.toBeInstanceOf(RenderCancelled);
    a.gate.resolve();
    await expect(p2).resolves.toBe('a');
    expect(started(log)).toEqual(['a']);
  });

  it('cancels the job when every interested caller has aborted', async () => {
    const q = new RenderQueue();
    const log: string[] = [];
    const a = job('a', 'near', log);
    const c1 = new AbortController();
    const c2 = new AbortController();
    const p1 = q.enqueue(a.job, c1.signal);
    const p2 = q.enqueue(a.job, c2.signal);
    await tick();
    c1.abort();
    c2.abort();
    await expect(p1).rejects.toBeInstanceOf(RenderCancelled);
    await expect(p2).rejects.toBeInstanceOf(RenderCancelled);
    await tick();
    expect(log).not.toContain('end a');
  });

  it('upgrades the priority of a queued job when requested again', async () => {
    const q = new RenderQueue({ concurrency: 1 });
    const log: string[] = [];
    const blocker = job('blocker', 'visible', log);
    const x = job('x', 'thumbnail', log);
    const y = job('y', 'near', log);
    void q.enqueue(blocker.job);
    void q.enqueue(x.job);
    void q.enqueue(y.job);
    void q.enqueue({ ...x.job, priority: 'visible' }); // thumbnail scrolled into view
    blocker.gate.resolve();
    await tick();
    expect(started(log)).toEqual(['blocker', 'x']);
  });

  it('cancelWhere drops matching work and allows re-enqueue of the same key', async () => {
    const q = new RenderQueue({ concurrency: 1 });
    const log: string[] = [];
    const a = job('page:1', 'near', log);
    const b = job('page:2', 'near', log);
    const pa = q.enqueue(a.job);
    void q.enqueue(b.job);
    q.cancelWhere((k) => k.startsWith('page:'));
    await expect(pa).rejects.toBeInstanceOf(RenderCancelled);
    const again = job('page:1', 'visible', log);
    const p = q.enqueue(again.job);
    again.gate.resolve();
    await expect(p).resolves.toBe('page:1');
  });

  it('a failing job does not stall the queue', async () => {
    const q = new RenderQueue({ concurrency: 1 });
    const bad = q.enqueue({ key: 'bad', priority: 'near', run: async () => { throw new Error('boom'); } });
    const ok = q.enqueue({ key: 'ok', priority: 'near', run: async () => 'fine' });
    await expect(bad).rejects.toThrow('boom');
    await expect(ok).resolves.toBe('fine');
  });
});

describe('CanvasPool / CanvasWindow', () => {
  const mk = () => new CanvasPool({ create: () => ({ width: 100, height: 100 }), maxIdle: 2 });

  it('reuses released canvases and shrinks them', () => {
    const pool = mk();
    const c = pool.acquire();
    pool.release(c);
    expect(c).toMatchObject({ width: 0, height: 0 });
    expect(pool.acquire()).toBe(c);
  });

  it('caps idle canvases', () => {
    const pool = mk();
    const cs = [pool.acquire(), pool.acquire(), pool.acquire()];
    cs.forEach((c) => pool.release(c));
    expect(pool.idleCount).toBe(2);
  });

  it('releases pages that leave the +/-2 window', () => {
    const pool = mk();
    const win = new CanvasWindow(pool, 2);
    for (let i = 0; i < 6; i++) win.get(i);
    expect(win.get(3)).toBe(win.get(3));
    expect(win.moveTo(5).sort()).toEqual([0, 1, 2]);
    expect(win.size).toBe(3);
    expect(win.has(3) && win.has(4) && win.has(5)).toBe(true);
    expect(pool.idleCount).toBe(2); // maxIdle caps the pool; the third was dropped
  });
});
