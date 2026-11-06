import { describe, expect, it } from "vitest";
import { findMatches, looksBinary, numberLines, replaceUnique, truncateMiddle } from "../src/agent/textOps";

describe("replaceUnique", () => {
  it("replaces a single occurrence", () => {
    expect(replaceUnique("hello world", "world", "there")).toEqual({ ok: true, text: "hello there" });
  });

  it("replaces in the middle of multi-line content", () => {
    expect(replaceUnique("a\nb\nc\n", "b", "B")).toEqual({ ok: true, text: "a\nB\nc\n" });
  });

  it("allows an empty new_str (deletion)", () => {
    expect(replaceUnique("abcdef", "cd", "")).toEqual({ ok: true, text: "abef" });
  });

  it("rejects an empty old_str", () => {
    const r = replaceUnique("abc", "", "x");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/empty/);
  });

  it("rejects empty old_str even on empty content", () => {
    expect(replaceUnique("", "", "x").ok).toBe(false);
  });

  it("reports not found", () => {
    const r = replaceUnique("abc", "zzz", "x");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/not found/);
  });

  it("reports multiple matches", () => {
    const r = replaceUnique("foo foo", "foo", "bar");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/more than once/);
  });

  it("detects overlapping matches as multiple", () => {
    expect(replaceUnique("aaa", "aa", "b").ok).toBe(false);
  });

  it("does not interpret $ patterns in new_str", () => {
    expect(replaceUnique("x", "x", "$&$1$$")).toEqual({ ok: true, text: "$&$1$$" });
  });

  it("does not treat old_str as a regex", () => {
    expect(replaceUnique("a.c abc", "a.c", "X")).toEqual({ ok: true, text: "X abc" });
  });

  describe("CRLF files", () => {
    it("matches LF old_str against CRLF content and keeps CRLF in the output", () => {
      const r = replaceUnique("one\r\ntwo\r\nthree\r\n", "one\ntwo", "uno\ndos");
      expect(r).toEqual({ ok: true, text: "uno\r\ndos\r\nthree\r\n" });
    });

    it("converts LF new_str to CRLF", () => {
      expect(replaceUnique("a\r\nb\r\n", "a", "x\ny")).toEqual({ ok: true, text: "x\r\ny\r\nb\r\n" });
    });

    it("does not double-convert a new_str that already has CRLF", () => {
      expect(replaceUnique("a\r\nb\r\n", "a", "x\r\ny")).toEqual({ ok: true, text: "x\r\ny\r\nb\r\n" });
    });

    it("leaves other CRLF line endings untouched", () => {
      expect(replaceUnique("a\r\nb\r\nc\r\n", "b", "B")).toEqual({ ok: true, text: "a\r\nB\r\nc\r\n" });
    });

    it("uses old_str as-is when it already contains CRLF", () => {
      expect(replaceUnique("a\r\nb\r\nc", "a\r\nb", "z")).toEqual({ ok: true, text: "z\r\nc" });
    });

    it("does not match a bare-LF pair inside a mixed-ending file", () => {
      expect(replaceUnique("x\r\ny\nz\nw", "y\nz", "q").ok).toBe(false);
    });

    it("detects multiple matches after conversion", () => {
      expect(replaceUnique("a\r\nb\r\na\r\nb\r\n", "a\nb", "c").ok).toBe(false);
    });

    it("leaves LF files alone", () => {
      expect(replaceUnique("a\nb\n", "a\nb", "c\nd")).toEqual({ ok: true, text: "c\nd\n" });
    });
  });
});

describe("numberLines", () => {
  it("numbers lines starting at 1 with a tab", () => {
    expect(numberLines("a\nb\nc")).toBe("1\ta\n2\tb\n3\tc");
  });

  it("pads numbers to a common width", () => {
    const content = Array.from({ length: 12 }, (_, i) => `l${i + 1}`).join("\n");
    const out = numberLines(content).split("\n");
    expect(out[0]).toBe(" 1\tl1");
    expect(out[8]).toBe(" 9\tl9");
    expect(out[9]).toBe("10\tl10");
    expect(out[11]).toBe("12\tl12");
  });

  it("honors offset (1-based)", () => {
    expect(numberLines("a\nb\nc\nd", 3)).toBe("3\tc\n4\td");
  });

  it("honors limit and appends a footer with the remaining count", () => {
    expect(numberLines("a\nb\nc\nd\ne", 1, 2)).toBe("1\ta\n2\tb\n... (3 more lines; use offset to read further)");
  });

  it("combines offset and limit", () => {
    expect(numberLines("a\nb\nc\nd\ne", 2, 2)).toBe("2\tb\n3\tc\n... (2 more lines; use offset to read further)");
  });

  it("has no footer when everything fits exactly", () => {
    expect(numberLines("a\nb", 1, 2)).toBe("1\ta\n2\tb");
  });

  it("pads using the last displayed number when offset is large", () => {
    const content = Array.from({ length: 105 }, (_, i) => `l${i + 1}`).join("\n");
    const out = numberLines(content, 98, 3).split("\n");
    expect(out[0]).toBe(" 98\tl98");
    expect(out[2]).toBe("100\tl100");
  });

  it("treats offset 0 and negatives as 1", () => {
    expect(numberLines("a\nb", 0)).toBe("1\ta\n2\tb");
    expect(numberLines("a\nb", -5)).toBe("1\ta\n2\tb");
  });

  it("splits CRLF and LF lines the same way, dropping the CR", () => {
    expect(numberLines("a\r\nb\r\n")).toBe(numberLines("a\nb\n"));
    expect(numberLines("a\r\nb")).not.toContain("\r");
  });

  it("handles empty content as one empty line", () => {
    expect(numberLines("")).toBe("1\t");
  });

  it("returns no content lines when offset is past the end", () => {
    const out = numberLines("a\nb", 10);
    expect(out).not.toContain("more lines");
    expect(out).not.toMatch(/\t[ab]/);
  });
});

describe("truncateMiddle", () => {
  it("returns short text unchanged", () => {
    expect(truncateMiddle("hello", 10)).toBe("hello");
  });

  it("returns text exactly at the limit unchanged", () => {
    const s = "x".repeat(100);
    expect(truncateMiddle(s, 100)).toBe(s);
  });

  it("keeps head and tail and reports the number of omitted characters", () => {
    const s = "A".repeat(50) + "M".repeat(900) + "Z".repeat(50);
    const out = truncateMiddle(s, 100);
    expect(out.startsWith("A".repeat(50))).toBe(true);
    expect(out.endsWith("Z".repeat(50))).toBe(true);
    expect(out).toContain("[900 characters omitted]");
    expect(out).not.toContain("M");
  });

  it("handles odd max values", () => {
    const out = truncateMiddle("a".repeat(10) + "b".repeat(10), 7);
    expect(out).toContain("[13 characters omitted]");
    expect(out.startsWith("aaa")).toBe(true);
    expect(out.endsWith("bbb")).toBe(true);
  });

  it("uses a 30000 default limit", () => {
    expect(truncateMiddle("x".repeat(30_000))).toHaveLength(30_000);
    expect(truncateMiddle("x".repeat(30_001))).toContain("[1 characters omitted]");
  });

  it("keeps output size bounded near the limit", () => {
    expect(truncateMiddle("x".repeat(100_000), 1000).length).toBeLessThan(1100);
  });
});

describe("looksBinary", () => {
  it("is false for empty input", () => {
    expect(looksBinary(new Uint8Array())).toBe(false);
  });

  it("is false for plain text", () => {
    expect(looksBinary(new TextEncoder().encode("hello\nworld\ttab"))).toBe(false);
  });

  it("is false for UTF-8 multibyte text", () => {
    expect(looksBinary(new TextEncoder().encode("héllo 世界 \u{1F600}"))).toBe(false);
  });

  it("is true when a NUL byte is present", () => {
    expect(looksBinary(Uint8Array.from([104, 105, 0, 106]))).toBe(true);
  });

  it("is true for a leading NUL", () => {
    expect(looksBinary(Uint8Array.from([0]))).toBe(true);
  });

  it("detects a NUL at index 7999 but ignores one at index 8000", () => {
    const a = new Uint8Array(9000).fill(65);
    a[7999] = 0;
    expect(looksBinary(a)).toBe(true);
    const b = new Uint8Array(9000).fill(65);
    b[8000] = 0;
    expect(looksBinary(b)).toBe(false);
  });

  it("works on Node Buffers", () => {
    expect(looksBinary(Buffer.from([1, 2, 0]))).toBe(true);
    expect(looksBinary(Buffer.from("text"))).toBe(false);
  });
});

describe("findMatches", () => {
  const content = "alpha\nbeta\n  gamma beta  \ndelta";

  it("returns 1-based line numbers and trimmed text", () => {
    expect(findMatches(content, /beta/, 10)).toEqual([
      { line: 2, text: "beta" },
      { line: 3, text: "gamma beta" },
    ]);
  });

  it("returns empty when nothing matches", () => {
    expect(findMatches(content, /zzz/, 10)).toEqual([]);
  });

  it("stops at max", () => {
    expect(findMatches("a\na\na\na", /a/, 2)).toHaveLength(2);
  });

  it("returns nothing for max 0", () => {
    expect(findMatches("a", /a/, 0)).toEqual([]);
  });

  it("caps text at 200 characters", () => {
    expect(findMatches("x".repeat(500), /x/, 1)[0].text).toHaveLength(200);
  });

  it("works with global regexes (lastIndex reset between lines)", () => {
    expect(findMatches("foo\nfoo\nfoo", /foo/g, 10).map((m) => m.line)).toEqual([1, 2, 3]);
  });

  it("works with sticky regexes", () => {
    expect(findMatches("foo\nfoo", /foo/y, 10).map((m) => m.line)).toEqual([1, 2]);
  });

  it("handles CRLF without leaking CR into results or anchors", () => {
    expect(findMatches("one\r\ntwo\r\n", /^two$/, 10)).toEqual([{ line: 2, text: "two" }]);
  });

  it("supports case-insensitive regexes", () => {
    expect(findMatches("Hello", /hello/i, 5)).toEqual([{ line: 1, text: "Hello" }]);
  });
});
