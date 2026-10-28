import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  prepare: vi.fn(),
  cancel: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth", () => ({ verifyRoleOrUnauthorized: mocks.auth }));
vi.mock("@/lib/document-submission", () => ({
  prepareDocumentSubmission: mocks.prepare,
  cancelDocumentSubmission: mocks.cancel,
}));
import { POST, DELETE } from "@/app/api/document-submission/route";
import { DocumentSubmissionError } from "@/lib/document-submission-token";

const userId = "11111111-1111-4111-8111-111111111111";
const input = {
  sessionId: "22222222-2222-4222-8222-222222222222",
  filename: "Synthetic.pdf",
  fileSizeBytes: 100,
  checksumSha256: "a".repeat(64),
  outputTarget: "accessible_pdf",
};
const ticket = {
  documentId: "33333333-3333-4333-8333-333333333333",
  submissionToken: "synthetic.signed-token",
  expiresAt: "2026-10-26T16:00:00.000Z",
};

function request(
  body: unknown = input,
  headers: Record<string, string> = {},
  method = "POST"
) {
  return new NextRequest("https://app.test/api/document-submission", {
    method,
    headers: {
      origin: "https://app.test",
      "content-type": "application/json",
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({ session: { user: { id: userId } } });
  mocks.prepare.mockResolvedValue(ticket);
  mocks.cancel.mockResolvedValue(undefined);
});

describe("stateless submission preparation route", () => {
  it.each([401, 403])(
    "requires an authorized role before preparing or cancelling (%s)",
    async (status) => {
      mocks.auth.mockResolvedValue({
        response: NextResponse.json({}, { status }),
      });
      expect((await POST(request())).status).toBe(status);
      expect(
        (
          await DELETE(
            request({ submissionToken: ticket.submissionToken }, {}, "DELETE")
          )
        ).status
      ).toBe(status);
      expect(mocks.auth).toHaveBeenCalledWith(["instructor", "admin"]);
      expect(mocks.prepare).not.toHaveBeenCalled();
      expect(mocks.cancel).not.toHaveBeenCalled();
    }
  );

  it.each<Record<string, string>>([
    { origin: "https://other.test" },
    { "sec-fetch-site": "cross-site" },
  ])("rejects cross-site preparation and cancellation: %j", async (headers) => {
    expect((await POST(request(input, headers))).status).toBe(403);
    expect(
      (
        await DELETE(
          request(
            { submissionToken: ticket.submissionToken },
            headers,
            "DELETE"
          )
        )
      ).status
    ).toBe(403);
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.cancel).not.toHaveBeenCalled();
  });

  it.each([
    { ...input, storageKey: "other-owner/source.pdf" },
    { ...input, documentId: ticket.documentId },
    { ...input, outputTarget: "unsupported" },
    { ...input, fileSizeBytes: 0 },
    { ...input, checksumSha256: "invalid" },
    { ...input, filename: "../Synthetic.pdf" },
  ])(
    "rejects invalid or extra metadata before the service: %j",
    async (body) => {
      const response = await POST(request(body));
      expect(response.status).toBe(400);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(mocks.prepare).not.toHaveBeenCalled();
    }
  );

  it("bounds streamed JSON without relying on Content-Length", async () => {
    const response = await POST(request("x".repeat(8193)));
    expect(response.status).toBe(413);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON and non-JSON content types", async () => {
    expect((await POST(request("{"))).status).toBe(400);
    expect(
      (await POST(request(input, { "content-type": "text/plain" }))).status
    ).toBe(400);
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it("returns only the prepared ticket without caching and binds it to the authenticated owner", async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(ticket);
    expect(mocks.prepare).toHaveBeenCalledExactlyOnceWith(userId, input);
    expect(mocks.cancel).not.toHaveBeenCalled();
  });

  it.each([400, 403, 410, 429, 503])(
    "preserves a controlled service status (%s)",
    async (status) => {
      mocks.prepare.mockRejectedValueOnce(
        new DocumentSubmissionError("Controlled preparation failure.", status)
      );
      const response = await POST(request());
      expect(response.status).toBe(status);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({
        error: "Controlled preparation failure.",
      });
    }
  );

  it("withholds database and provider details on uncertain preparation or cancellation", async () => {
    mocks.prepare.mockRejectedValueOnce(
      new Error("SECRET database connection")
    );
    mocks.cancel.mockRejectedValueOnce(new Error("SECRET storage response"));
    for (const response of [
      await POST(request()),
      await DELETE(
        request({ submissionToken: ticket.submissionToken }, {}, "DELETE")
      ),
    ]) {
      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(JSON.stringify(await response.json())).not.toContain("SECRET");
    }
  });

  it("cancels only the supplied signed identity for the authenticated owner", async () => {
    const response = await DELETE(
      request({ submissionToken: ticket.submissionToken }, {}, "DELETE")
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ cancelled: true });
    expect(mocks.cancel).toHaveBeenCalledExactlyOnceWith(
      userId,
      ticket.submissionToken
    );
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it.each([
    {},
    { documentId: ticket.documentId },
    { submissionToken: 42 },
    { submissionToken: ticket.submissionToken, sessionId: input.sessionId },
    [],
  ])(
    "rejects cancellation without its exact token contract: %j",
    async (body) => {
      expect((await DELETE(request(body, {}, "DELETE"))).status).toBe(400);
      expect(mocks.cancel).not.toHaveBeenCalled();
    }
  );
});
