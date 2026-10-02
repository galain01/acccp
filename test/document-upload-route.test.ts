import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), reserve: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth", () => ({ verifyRoleOrUnauthorized: mocks.auth }));
vi.mock("@/lib/document-retention", () => ({
  DocumentUnavailableError: class extends Error {},
}));
vi.mock("@/lib/document-upload", () => ({
  reservePowerPointUpload: mocks.reserve,
  isPowerPointUploadRequest: (value: object) =>
    Boolean(value && Object.keys(value).length === 4),
  DocumentUploadError: class extends Error {
    constructor(
      message: string,
      readonly status = 400
    ) {
      super(message);
    }
  },
}));
import { POST } from "@/app/api/document-upload/route";
const input = {
  sessionId: "known",
  filename: "Lecture.pptx",
  fileSizeBytes: 20,
  checksumSha256: "a".repeat(64),
};
function request(body: unknown = input, headers: Record<string, string> = {}) {
  return new NextRequest("https://app.test/api/document-upload", {
    method: "POST",
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
  mocks.auth.mockResolvedValue({ session: { user: { id: "owner" } } });
  mocks.reserve.mockResolvedValue({
    documentId: "known",
    uploadUrl: "https://storage.test/signed",
  });
});
describe("direct upload route", () => {
  it("requires an authorized role", async () => {
    mocks.auth.mockResolvedValue({
      response: NextResponse.json({}, { status: 401 }),
    });
    expect((await POST(request())).status).toBe(401);
    expect(mocks.reserve).not.toHaveBeenCalled();
  });
  it("rejects cross-site mutations", async () => {
    expect(
      (await POST(request(input, { origin: "https://other.test" }))).status
    ).toBe(403);
    expect(mocks.reserve).not.toHaveBeenCalled();
  });
  it("bounds untrusted streamed JSON without Content-Length", async () => {
    expect((await POST(request("x".repeat(4097)))).status).toBe(413);
    expect(mocks.reserve).not.toHaveBeenCalled();
  });
  it("rejects arbitrary storage keys and malformed requests", async () => {
    expect(
      (await POST(request({ ...input, key: "someone/else" }))).status
    ).toBe(400);
    expect((await POST(request("{"))).status).toBe(400);
    expect(mocks.reserve).not.toHaveBeenCalled();
  });
  it("returns an owned reservation without caching", async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.reserve).toHaveBeenCalledWith("owner", input);
  });
  it("withholds provider details", async () => {
    mocks.reserve.mockRejectedValue(new Error("SECRET"));
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain("SECRET");
  });
});
