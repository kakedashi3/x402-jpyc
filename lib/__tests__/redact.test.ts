import { describe, expect, it } from "vitest";
import { redactId } from "../redact.js";

describe("redactId", () => {
  it("returns 'none' for null / undefined / empty string", () => {
    expect(redactId(null)).toBe("none");
    expect(redactId(undefined)).toBe("none");
    expect(redactId("")).toBe("none");
  });

  it("returns '***' for strings of 8 characters or fewer", () => {
    expect(redactId("k")).toBe("***");
    expect(redactId("short")).toBe("***");
    expect(redactId("12345678")).toBe("***");
  });

  it("masks the middle of longer strings, keeping a prefix and suffix", () => {
    // 9 chars — the first length that exceeds the "***" threshold.
    expect(redactId("123456789")).toBe("1234…89");
    // 10 chars — matches the example in the redactId doc comment.
    expect(redactId("ak_123459f")).toBe("ak_1…9f");
    expect(redactId("key-id-12345")).toBe("key-…45");
  });
});
