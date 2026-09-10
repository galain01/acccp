import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

function json(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const supplied = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret ?? ""}`);
  if (
    !secret ||
    secret.length < 32 ||
    supplied.length !== expected.length ||
    !timingSafeEqual(supplied, expected)
  ) {
    return json({ error: "Unauthorized" }, 401);
  }

  // The separate test project shares storage with production. A production
  // deployment alone is insufficient authorization to enable deletion there.
  if (process.env.VERCEL_ENV !== "production") {
    return json({ error: "Purge is available only in production." }, 403);
  }
  const dryRunValue = request.nextUrl.searchParams.get("dryRun");
  if (dryRunValue !== null && dryRunValue !== "true") {
    return json({ error: "Use dryRun=true for a read-only preview." }, 400);
  }
  const dryRun = dryRunValue === "true";
  if (!dryRun && process.env.DOCUMENT_PURGE_ENABLED !== "true") {
    return json({ error: "Document purge is not enabled." }, 503);
  }

  try {
    // Lazy loading keeps missing DB/storage configuration behind authentication.
    const { purgeExpiredDocuments } = await import("@/lib/document-retention");
    const result = await purgeExpiredDocuments({
      dryRun,
      limit: 200,
      maxDurationMs: 240_000,
    });
    const incomplete =
      !dryRun &&
      (result.failed > 0 || result.hasMore || result.timeLimitReached);
    // Only counts and flags; no file names, snippets, keys or provider errors.
    console[incomplete ? "error" : "log"]("[document-purge]", result);
    return json({ ok: !incomplete, ...result }, incomplete ? 503 : 200);
  } catch {
    console.error("[document-purge] run failed; retry required");
    return json({ error: "Document purge failed. Retry required." }, 503);
  }
}
