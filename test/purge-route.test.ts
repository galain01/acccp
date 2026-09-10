import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { readFileSync } from "node:fs";

const { purge } = vi.hoisted(() => ({ purge: vi.fn() }));
vi.mock("@/lib/document-retention", () => ({ purgeExpiredDocuments: purge }));
import { GET } from "@/app/api/cron/purge-documents/route";

const secret = "synthetic-cron-secret-for-unit-tests-only";
const complete = {
  dryRun: false,
  examined: 2,
  eligible: 2,
  purged: 2,
  failed: 0,
  timeLimitReached: false,
  limitReached: false,
  hasMore: false,
};

function request(
  authorization: string | null = `Bearer ${secret}`,
  query = ""
) {
  return new NextRequest(
    `https://example.test/api/cron/purge-documents${query}`,
    {
      headers: authorization === null ? {} : { authorization },
    }
  );
}

describe("scheduled document purge", () => {
  beforeEach(() => {
    vi.stubEnv("CRON_SECRET", secret);
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("DOCUMENT_PURGE_ENABLED", "true");
    purge.mockReset().mockResolvedValue(complete);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it.each([null, "", "Bearer wrong", `Bearer ${secret.slice(1)}x`])(
    "rejects missing or incorrect authorization without touching data: %s",
    async (header) => {
      expect((await GET(request(header))).status).toBe(401);
      expect(purge).not.toHaveBeenCalled();
    }
  );
  it.each(["", "short"])(
    "fails closed for unconfigured/weak secret: %s",
    async (value) => {
      vi.stubEnv("CRON_SECRET", value);
      expect((await GET(request(`Bearer ${value}`))).status).toBe(401);
      expect(purge).not.toHaveBeenCalled();
    }
  );
  it.each(["preview", "development", ""])(
    "blocks non-production environment %s",
    async (value) => {
      vi.stubEnv("VERCEL_ENV", value);
      expect((await GET(request())).status).toBe(403);
      expect((await GET(request(undefined, "?dryRun=true"))).status).toBe(403);
      expect(purge).not.toHaveBeenCalled();
    }
  );
  it("requires explicit enablement even in the separate test project's Production environment", async () => {
    vi.stubEnv("DOCUMENT_PURGE_ENABLED", "");
    expect((await GET(request())).status).toBe(503);
    expect(purge).not.toHaveBeenCalled();
  });
  it("allows an authenticated dry run before enabling actual deletion", async () => {
    vi.stubEnv("DOCUMENT_PURGE_ENABLED", "");
    purge.mockResolvedValue({
      ...complete,
      dryRun: true,
      purged: 0,
      eligible: 900,
      hasMore: true,
    });
    const response = await GET(request(undefined, "?dryRun=true"));
    expect(response.status).toBe(200);
    expect(purge).toHaveBeenCalledWith({
      dryRun: true,
      limit: 200,
      maxDurationMs: 240_000,
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it.each(["false", "1", ""])(
    "rejects ambiguous dry-run requests %s",
    async (value) => {
      expect((await GET(request(undefined, `?dryRun=${value}`))).status).toBe(
        400
      );
      expect(purge).not.toHaveBeenCalled();
    }
  );
  it("runs a bounded purge and returns only its aggregate result", async () => {
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(purge).toHaveBeenCalledWith({
      dryRun: false,
      limit: 200,
      maxDurationMs: 240_000,
    });
    expect(await response.json()).toEqual({ ok: true, ...complete });
  });
  it.each([{ failed: 1 }, { hasMore: true }, { timeLimitReached: true }])(
    "reports incomplete cleanup for operator retry: %j",
    async (incomplete) => {
      purge.mockResolvedValue({ ...complete, ...incomplete });
      const response = await GET(request());
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ ok: false });
    }
  );
  it("does not report failure just because the last full batch exhausted the work", async () => {
    purge.mockResolvedValue({
      ...complete,
      limitReached: true,
      hasMore: false,
    });
    expect((await GET(request())).status).toBe(200);
  });
  it("keeps raw provider errors and document data out of logs and responses", async () => {
    purge.mockRejectedValue(
      new Error("student-name storage-secret postgres://credentials")
    );
    const response = await GET(request());
    expect(response.status).toBe(503);
    expect(
      JSON.stringify([
        await response.json(),
        vi.mocked(console.error).mock.calls,
      ])
    ).not.toMatch(/student-name|storage-secret|postgres:\/\/credentials/);
  });
  it("registers the endpoint once daily through the public web service", () => {
    const config = JSON.parse(
      readFileSync(new URL("../vercel.json", import.meta.url), "utf8")
    );
    expect(config.crons).toEqual([
      { path: "/api/cron/purge-documents", schedule: "0 3 * * *" },
    ]);
    expect(config.rewrites).toContainEqual({
      source: "/(.*)",
      destination: { service: "web" },
    });
  });
});
