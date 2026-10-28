import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import {
  issueSubmissionToken,
  readSubmissionToken,
} from "@/lib/document-submission-token";

const owner = "11111111-1111-4111-8111-111111111111";
const input = {
  sessionId: "22222222-2222-4222-8222-222222222222",
  filename: "Lesson.pdf",
  fileSizeBytes: 123,
  checksumSha256: "a".repeat(64),
  outputTarget: "accessible_pdf" as const,
};
beforeEach(() => {
  vi.stubEnv(
    "BETTER_AUTH_SECRET",
    "synthetic-submission-test-secret-at-least-32-chars"
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});
describe("initial submission identity", () => {
  it("binds a fresh server identity to exact owner, source and target", () => {
    const first = issueSubmissionToken(owner, input);
    const second = issueSubmissionToken(owner, input);
    expect(first.documentId).not.toBe(second.documentId);
    expect(readSubmissionToken(first.submissionToken, owner)).toMatchObject({
      ...input,
      userId: owner,
      documentId: first.documentId,
      version: 1,
    });
  });
  it("rejects changed contents, owner and expired tokens without refreshing the deadline", () => {
    vi.useFakeTimers();
    const prepared = issueSubmissionToken(owner, input);
    const [body, signature] = prepared.submissionToken.split(".");
    const claims = JSON.parse(Buffer.from(body, "base64url").toString());
    claims.outputTarget = "canvas_html";
    expect(() =>
      readSubmissionToken(
        `${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${signature}`,
        owner
      )
    ).toThrow();
    expect(() =>
      readSubmissionToken(
        prepared.submissionToken,
        "33333333-3333-4333-8333-333333333333"
      )
    ).toThrow();
    vi.setSystemTime(Date.parse(prepared.expiresAt) + 1);
    expect(() =>
      readSubmissionToken(prepared.submissionToken, owner)
    ).toThrow();
    expect(
      readSubmissionToken(prepared.submissionToken, owner, {
        allowExpired: true,
      }).documentId
    ).toBe(prepared.documentId);
  });
  it.each(["", "a.b", "a".repeat(4097), "eyJ2ZXJzaW9uIjoxfQ.invalid"])(
    "rejects malformed and oversized token",
    (token) => {
      expect(() => readSubmissionToken(token, owner)).toThrow();
    }
  );
  it("refuses unsafe names, unsupported targets and a missing signing secret", () => {
    expect(() =>
      issueSubmissionToken(owner, { ...input, filename: "../private.pdf" })
    ).toThrow();
    expect(() =>
      issueSubmissionToken(owner, { ...input, outputTarget: "accessible_docx" })
    ).toThrow();
    vi.stubEnv("BETTER_AUTH_SECRET", "");
    expect(() => issueSubmissionToken(owner, input)).toThrow();
  });
});
