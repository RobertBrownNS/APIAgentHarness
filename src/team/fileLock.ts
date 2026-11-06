import * as path from "node:path";

const tails = new Map<string, Promise<unknown>>();
const STOPPED = "stopped while waiting for the file lock";

function keyFor(absPath: string): string {
  const p = path.resolve(absPath);
  return process.platform === "win32" ? p.toLowerCase() : p;
}

/**
 * Run fn once every earlier call for the same file has settled (FIFO). A failing fn does not block the next one.
 * If `signal` aborts while waiting, the call rejects without running fn and leaves the queue.
 */
export function withFileLock<T>(absPath: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const key = keyFor(absPath);
  const prev = tails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => (release = r));
  const chained = Promise.all([prev, mine]).then(() => undefined);
  tails.set(key, chained);
  void chained.then(() => {
    if (tails.get(key) === chained) tails.delete(key);
  });

  return new Promise<T>((resolve, reject) => {
    let started = false;
    const onAbort = () => {
      if (started) return;
      reject(new Error(STOPPED));
      release(); // the next waiter only waits for the one before this one
    };
    if (signal?.aborted) {
      release();
      return reject(new Error(STOPPED));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    void prev.then(() => {
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) return release();
      started = true;
      Promise.resolve().then(fn).then(resolve, reject).finally(release);
    });
  });
}
