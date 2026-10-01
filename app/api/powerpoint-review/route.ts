import { NextRequest, NextResponse } from "next/server";
import { verifyRoleOrUnauthorized } from "@/lib/auth";
import { DocumentUnavailableError } from "@/lib/document-retention";
import { isPowerPointReviewSelection } from "@/lib/powerpoint-review-contract";
import {
  exportOwnedPowerPointReview,
  PowerPointReviewError,
} from "@/lib/powerpoint-review-storage";

export const runtime = "nodejs";
export const maxDuration = 300;

const json = (body: unknown, status = 200) =>
  NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function POST(request: NextRequest) {
  const authorization = await verifyRoleOrUnauthorized(["instructor", "admin"]);
  if ("response" in authorization) return authorization.response;
  // This mutation is used only by our own UI; cookies alone do not authorize cross-site calls.
  if (
    request.headers.get("origin") !== request.nextUrl.origin ||
    request.headers.get("sec-fetch-site") === "cross-site"
  )
    return json(
      { error: "Open the review from this application before exporting." },
      403
    );
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    return json({ error: "Expected review choices as JSON." }, 400);
  if (Number(request.headers.get("content-length")) > 256_000)
    return json({ error: "The review choices are too large." }, 413);
  let input: unknown;
  try {
    // Count bytes while streaming, including requests with no Content-Length.
    const reader = request.body?.getReader();
    if (!reader)
      return json({ error: "No review choices were provided." }, 400);
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      bytes += item.value.byteLength;
      if (bytes > 256_000) {
        await reader.cancel();
        return json({ error: "The review choices are too large." }, 413);
      }
      chunks.push(item.value);
    }
    input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return json({ error: "The review choices were not valid JSON." }, 400);
  }
  if (!isPowerPointReviewSelection(input))
    return json({ error: "The review choices were not valid." }, 400);
  try {
    return json(
      await exportOwnedPowerPointReview(authorization.session.user.id, input)
    );
  } catch (error) {
    if (error instanceof DocumentUnavailableError)
      return json({ error: "This presentation is no longer available." }, 404);
    if (error instanceof PowerPointReviewError)
      return json({ error: error.message }, error.status);
    return json(
      {
        error:
          "Could not prepare the selected presentation. Your previous download is still available. Please try again.",
      },
      500
    );
  }
}
