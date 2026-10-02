import { NextRequest, NextResponse } from "next/server";
import { verifyRoleOrUnauthorized } from "@/lib/auth";
import { DocumentUnavailableError } from "@/lib/document-retention";
import {
  DocumentUploadError,
  isPowerPointUploadRequest,
  reservePowerPointUpload,
} from "@/lib/document-upload";

export const runtime = "nodejs";
export const maxDuration = 60;
const json = (body: unknown, status = 200) =>
  NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function POST(request: NextRequest) {
  const authorization = await verifyRoleOrUnauthorized(["instructor", "admin"]);
  if ("response" in authorization) return authorization.response;
  if (
    (request.headers.get("origin") &&
      request.headers.get("origin") !== request.nextUrl.origin) ||
    request.headers.get("sec-fetch-site") === "cross-site"
  )
    return json(
      { error: "Open this application before uploading a presentation." },
      403
    );
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    return json({ error: "Expected upload details as JSON." }, 400);
  if (Number(request.headers.get("content-length")) > 4096)
    return json({ error: "Upload details are too large." }, 413);
  let input: unknown;
  try {
    const reader = request.body?.getReader();
    if (!reader) return json({ error: "Upload details are missing." }, 400);
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 4096) {
          await reader.cancel();
          return json({ error: "Upload details are too large." }, 413);
        }
        chunks.push(chunk.value);
      }
    } finally {
      reader.releaseLock();
    }
    input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return json({ error: "Upload details are not valid JSON." }, 400);
  }
  if (!isPowerPointUploadRequest(input))
    return json(
      { error: "Choose a PowerPoint presentation no larger than 25 MB." },
      400
    );
  try {
    return json(
      await reservePowerPointUpload(authorization.session.user.id, input)
    );
  } catch (error) {
    if (error instanceof DocumentUnavailableError)
      return json({ error: "This upload is no longer available." }, 404);
    if (error instanceof DocumentUploadError)
      return json({ error: error.message }, error.status);
    return json(
      { error: "Could not prepare the presentation upload. Please try again." },
      503
    );
  }
}
