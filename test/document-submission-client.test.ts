import { webcrypto, createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  prepareDocumentSubmission,
  cancelDocumentSubmission,
} from "@/lib/document-submission-client";
const fetchMock = vi.fn<typeof fetch>();
const documentId = "11111111-1111-4111-8111-111111111111";
beforeEach(() => {
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});
afterEach(() => vi.unstubAllGlobals());
describe("browser submission preparation", () => {
  it("learns the exact identity before any source mutation and retains it after cancellation", async () => {
    const file = new File(["%PDF-synthetic"], "Lecture.pdf");
    const controller = new AbortController();
    const onPrepared = vi.fn();
    fetchMock.mockImplementationOnce(async () => {
      controller.abort();
      return Response.json({
        documentId,
        submissionToken: "signed.preparation",
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      });
    });
    await expect(
      prepareDocumentSubmission({
        file,
        sessionId: "session",
        outputTarget: "accessible_pdf",
        signal: controller.signal,
        onPrepared,
      })
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(onPrepared).toHaveBeenCalledWith(
      expect.objectContaining({
        documentId,
        submissionToken: "signed.preparation",
        checksumSha256: createHash("sha256")
          .update("%PDF-synthetic")
          .digest("hex"),
      })
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/document-submission");
  });
  it("cancels with the signed identity without sending document content", async () => {
    fetchMock.mockResolvedValue(Response.json({ cancelled: true }));
    await cancelDocumentSubmission("signed.preparation");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/document-submission",
      expect.objectContaining({
        method: "DELETE",
        body: JSON.stringify({ submissionToken: "signed.preparation" }),
      })
    );
  });
});
