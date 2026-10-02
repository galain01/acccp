import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), export: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth", () => ({ verifyRoleOrUnauthorized: mocks.auth }));
vi.mock("@/lib/document-retention", () => ({
  DocumentUnavailableError: class extends Error {},
}));
vi.mock("@/lib/powerpoint-review-storage", () => ({
  exportOwnedPowerPointReview: mocks.export,
  PowerPointReviewError: class extends Error {
    constructor(
      message: string,
      readonly status = 409
    ) {
      super(message);
    }
  },
}));
import { POST } from "@/app/api/powerpoint-review/route";
import { PowerPointReviewError } from "@/lib/powerpoint-review-storage";
import { DocumentUnavailableError } from "@/lib/document-retention";
const valid = {
  documentId: "00000000-0000-0000-0000-000000000001",
  jobId: "00000000-0000-0000-0000-000000000002",
  revisionToken: "a".repeat(64),
  includedChangeIds: [],
  reviewedChangeIds: [],
  descriptionEdits: {},
};
function request(body: unknown = valid, headers: Record<string, string> = {}) {
  return new NextRequest("https://app.example/api/powerpoint-review", {
    method: "POST",
    headers: {
      origin: "https://app.example",
      "content-type": "application/json",
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({ session: { user: { id: "owner" } } });
  mocks.export.mockResolvedValue({
    url: "https://storage.test/export",
    filename: "file.pptx",
    findings: [],
    changes: [],
    revisionToken: "b".repeat(64),
  });
});
describe("selected PowerPoint export route", () => {
  it("requires an instructor/admin session", async () => {
    mocks.auth.mockResolvedValue({
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    });
    expect((await POST(request())).status).toBe(401);
    expect(mocks.export).not.toHaveBeenCalled();
  });
  it("rejects cross-origin cookie requests", async () => {
    expect(
      (await POST(request(valid, { origin: "https://elsewhere.example" })))
        .status
    ).toBe(403);
    expect(mocks.export).not.toHaveBeenCalled();
  });
  it("rejects multipart, injected plans and bad JSON", async () => {
    expect(
      (await POST(request(valid, { "content-type": "multipart/form-data" })))
        .status
    ).toBe(400);
    expect(
      (await POST(request({ ...valid, plan: { slides: [] } }))).status
    ).toBe(400);
    expect((await POST(request("invalid"))).status).toBe(400);
    expect(mocks.export).not.toHaveBeenCalled();
  });
  it("bounds bodies even when Content-Length is absent", async () => {
    expect((await POST(request("x".repeat(256001)))).status).toBe(413);
    expect(mocks.export).not.toHaveBeenCalled();
  });
  it("returns only the owned checked export with no-store", async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.export).toHaveBeenCalledWith("owner", valid);
  });
  it("uses a safe error for provider, SQL and storage failures", async () => {
    mocks.export.mockRejectedValue(new Error("secret provider details"));
    const response = await POST(request());
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain("secret");
  });
  it("returns a stale selection message without attempting to override it", async () => {
    mocks.export.mockRejectedValue(
      new PowerPointReviewError("Reopen the review.")
    );
    const response = await POST(request());
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "Reopen the review." });
  });
  it("returns unavailable after expiry", async () => {
    mocks.export.mockRejectedValue(new DocumentUnavailableError());
    expect((await POST(request())).status).toBe(404);
  });
});
