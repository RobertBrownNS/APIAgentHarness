import { describe, expect, it } from "vitest";
import * as path from "node:path";
import { withFileLock } from "../src/team/fileLock";

const tick = () => new Promise((r) => setTimeout(r, 5));
function gate() {
  let open!: () => void;
  const p = new Promise<void>((r) => (open = r));
  return { p, open };
}
const P = (s: string) => path.resolve(s);

describe("withFileLock", () => {
  it("serialises calls on the same file in FIFO order", async () => {
    const log: string[] = [];
    const g1 = gate();
    const a = withFileLock(P("/x/a.txt"), async () => {
      log.push("a1");
      await g1.p;
      log.push("a2");
    });
    const b = withFileLock(P("/x/a.txt"), async () => {
      log.push("b");
    });
    await tick();
    expect(log).toEqual(["a1"]);
    g1.open();
    await Promise.all([a, b]);
    expect(log).toEqual(["a1", "a2", "b"]);
  });
  it("different files run concurrently", async () => {
    const g = gate();
    const log: string[] = [];
    const a = withFileLock(P("/x/a.txt"), async () => {
      await g.p;
      log.push("a");
    });
    await withFileLock(P("/x/b.txt"), async () => {
      log.push("b");
    });
    expect(log).toEqual(["b"]);
    g.open();
    await a;
  });
  it("returns the fn result", async () => {
    expect(await withFileLock(P("/x/r"), async () => 42)).toBe(42);
  });
  it("an error releases the lock and propagates to its own caller only", async () => {
    const a = withFileLock(P("/x/e"), async () => {
      throw new Error("boom");
    });
    const b = withFileLock(P("/x/e"), async () => "ok");
    await expect(a).rejects.toThrow("boom");
    await expect(b).resolves.toBe("ok");
  });
  it("a synchronous throw inside fn is a rejection and releases the lock", async () => {
    const a = withFileLock(P("/x/s"), (() => {
      throw new Error("sync");
    }) as () => Promise<void>);
    await expect(a).rejects.toThrow("sync");
    await expect(withFileLock(P("/x/s"), async () => 1)).resolves.toBe(1);
  });
  it("many contenders never overlap", async () => {
    let active = 0,
      max = 0;
    await Promise.all(
      Array.from({ length: 25 }, () =>
        withFileLock(P("/x/many"), async () => {
          active++;
          max = Math.max(max, active);
          await tick();
          active--;
        }),
      ),
    );
    expect(max).toBe(1);
  });
  it("normalises equivalent paths (. and .. segments)", async () => {
    const log: string[] = [];
    const g = gate();
    const a = withFileLock(P("/x/y/../a.txt"), async () => {
      await g.p;
      log.push("a");
    });
    const b = withFileLock(P("/x/./a.txt"), async () => {
      log.push("b");
    });
    await tick();
    expect(log).toEqual([]);
    g.open();
    await Promise.all([a, b]);
    expect(log).toEqual(["a", "b"]);
  });
  it.runIf(process.platform === "win32")("is case-insensitive on Windows", async () => {
    const log: string[] = [];
    const g = gate();
    const a = withFileLock("C:\\Proj\\File.TS", async () => {
      await g.p;
      log.push("a");
    });
    const b = withFileLock("c:\\proj\\file.ts", async () => {
      log.push("b");
    });
    await tick();
    expect(log).toEqual([]);
    g.open();
    await Promise.all([a, b]);
    expect(log).toEqual(["a", "b"]);
  });
  it.runIf(process.platform !== "win32")("is case-sensitive on POSIX", async () => {
    const g = gate();
    const log: string[] = [];
    const a = withFileLock("/x/File", async () => {
      await g.p;
    });
    await withFileLock("/x/file", async () => {
      log.push("b");
    });
    expect(log).toEqual(["b"]);
    g.open();
    await a;
  });
  it("after all settle, a new call starts immediately", async () => {
    await withFileLock(P("leak.txt"), async () => 1);
    await tick();
    const log: string[] = [];
    await withFileLock(P("leak.txt"), async () => {
      log.push("x");
    });
    expect(log).toEqual(["x"]);
  });
});

// Decision 11 (TEAMS.md): withFileLock takes the caller's AbortSignal; an aborted waiter leaves the queue.
describe("withFileLock abort (decision 11)", () => {
  const lock = withFileLock as unknown as <T>(p: string, fn: () => Promise<T>, signal?: AbortSignal) => Promise<T>;
  it("an aborted waiter rejects, never runs fn, and does not block later waiters", async () => {
    const g = gate();
    const ac = new AbortController();
    const ran: string[] = [];
    const first = lock(P("/x/ab"), async () => {
      await g.p;
      ran.push("first");
    });
    const waiter = lock(
      P("/x/ab"),
      async () => {
        ran.push("waiter");
      },
      ac.signal,
    );
    const third = lock(P("/x/ab"), async () => {
      ran.push("third");
    });
    ac.abort();
    await expect(waiter).rejects.toBeDefined();
    g.open();
    await Promise.all([first, third]);
    expect(ran).toEqual(["first", "third"]);
  });
  it("an already-aborted signal rejects without running fn", async () => {
    const ac = new AbortController();
    ac.abort();
    let ran = false;
    await expect(
      lock(
        P("/x/ab2"),
        async () => {
          ran = true;
        },
        ac.signal,
      ),
    ).rejects.toBeDefined();
    expect(ran).toBe(false);
  });
});
