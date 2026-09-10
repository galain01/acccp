import { describe, expect, it } from "vitest";
import {
  DOCUMENT_RETENTION_MS,
  isDocumentExpired,
  retentionCutoff,
  retentionExpiresAt,
} from "@/lib/retention";

describe("fixed document retention", () => {
  it("expires at exactly 14 elapsed days, including the exact boundary", () => {
    const created = "2026-09-01T12:30:00.000Z";
    expect(DOCUMENT_RETENTION_MS).toBe(1_209_600_000);
    expect(retentionExpiresAt(created)).toBe("2026-09-15T12:30:00.000Z");
    expect(
      isDocumentExpired(created, new Date("2026-09-15T12:29:59.999Z"))
    ).toBe(false);
    expect(
      isDocumentExpired(created, new Date("2026-09-15T12:30:00.000Z"))
    ).toBe(true);
    expect(retentionCutoff(new Date("2026-09-15T12:30:00.000Z"))).toBe(created);
  });

  it("uses elapsed hours across spring and autumn daylight-saving changes", () => {
    for (const created of [
      "2026-03-01T12:00:00-05:00",
      "2026-10-25T12:00:00-04:00",
    ]) {
      const expiry = Date.parse(retentionExpiresAt(created));
      expect(expiry - Date.parse(created)).toBe(336 * 60 * 60 * 1000);
    }
  });

  it("accepts Date inputs without modifying the original timestamp", () => {
    const created = new Date("2026-09-01T00:00:00.000Z");
    const snapshot = created.getTime();
    expect(retentionExpiresAt(created)).toBe("2026-09-15T00:00:00.000Z");
    expect(created.getTime()).toBe(snapshot);
  });

  it("rejects invalid dates rather than allowing an indefinite lifetime", () => {
    expect(() => retentionExpiresAt("invalid")).toThrow(RangeError);
    expect(() => isDocumentExpired("2026-09-01", new Date(NaN))).toThrow(
      RangeError
    );
    expect(() => retentionCutoff(new Date(NaN))).toThrow(RangeError);
  });
});
