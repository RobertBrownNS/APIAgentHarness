import { beforeEach, describe, expect, it, vi } from "vitest";
import { MailboxImpl } from "../src/team/mailbox";

let m: MailboxImpl;
beforeEach(() => {
  m = new MailboxImpl();
});
const msg = (to: string, text = "hi", from = "a") => ({ from, to, text });

describe("Mailbox", () => {
  it("queues per recipient in order, drain empties", () => {
    m.send(msg("b", "1"));
    m.send(msg("c", "x"));
    m.send(msg("b", "2"));
    expect(m.pending("b")).toBe(2);
    expect(m.drain("b").map((x) => x.text)).toEqual(["1", "2"]);
    expect(m.pending("b")).toBe(0);
    expect(m.drain("b")).toEqual([]);
    expect(m.pending("c")).toBe(1);
  });
  it("drain of unknown agent is empty; pending 0", () => {
    expect(m.drain("zz")).toEqual([]);
    expect(m.pending("zz")).toBe(0);
  });
  it("preserves the idle flag", () => {
    m.send({ from: "a", to: "lead", text: "done", idle: true });
    expect(m.drain("lead")[0].idle).toBe(true);
  });
  it("later mutation of the sent object does not change the queued mail", () => {
    const x = msg("b", "orig");
    m.send(x);
    x.text = "changed";
    expect(m.drain("b")[0].text).toBe("orig");
  });
  it("listeners fire per send, after the message is queued", () => {
    const seen: number[] = [];
    m.onDeliver(() => seen.push(m.pending("b")));
    m.send(msg("b"));
    expect(seen).toEqual([1]);
  });
  it("a listener may drain re-entrantly (wake-up) without losing messages", () => {
    const got: string[] = [];
    m.onDeliver((x) => got.push(...m.drain(x.to).map((y) => y.text)));
    m.send(msg("b", "1"));
    m.send(msg("b", "2"));
    expect(got).toEqual(["1", "2"]);
  });
  it("a throwing listener does not block delivery or other listeners", () => {
    const l = vi.fn();
    m.onDeliver(() => {
      throw new Error("x");
    });
    m.onDeliver(l);
    expect(() => m.send(msg("b"))).not.toThrow();
    expect(l).toHaveBeenCalledTimes(1);
    expect(m.pending("b")).toBe(1);
  });
  it("unsubscribe stops notifications", () => {
    const l = vi.fn();
    const off = m.onDeliver(l);
    off();
    m.send(msg("b"));
    expect(l).not.toHaveBeenCalled();
  });
  it("clear empties all inboxes", () => {
    m.send(msg("b"));
    m.send(msg("c"));
    m.clear();
    expect(m.pending("b") + m.pending("c")).toBe(0);
  });
  it("agent names like __proto__ / constructor are safe", () => {
    m.send(msg("__proto__", "x"));
    m.send(msg("constructor", "y"));
    expect(m.drain("__proto__")[0].text).toBe("x");
    expect(m.drain("constructor")[0].text).toBe("y");
    expect(m.pending("toString")).toBe(0);
  });
});
