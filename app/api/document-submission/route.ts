import { NextRequest, NextResponse } from "next/server";
import { verifyRoleOrUnauthorized } from "@/lib/auth";
import {
  readBoundedRequestBody,
  RequestBodyError,
} from "@/lib/bounded-request-body";
import {
  cancelDocumentSubmission,
  prepareDocumentSubmission,
} from "@/lib/document-submission";
import {
  DocumentSubmissionError,
  isSubmissionMetadata,
} from "@/lib/document-submission-token";

export const runtime = "nodejs";
export const maxDuration = 30;
const json = (body: unknown, status = 200) =>
  NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
async function handle(request: NextRequest, cancel: boolean) {
  const auth = await verifyRoleOrUnauthorized(["instructor", "admin"]);
  if ("response" in auth) return auth.response;
  if (
    (request.headers.get("origin") &&
      request.headers.get("origin") !== request.nextUrl.origin) ||
    request.headers.get("sec-fetch-site") === "cross-site"
  )
    return json(
      { error: "Open this application before preparing an upload." },
      403
    );
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    return json({ error: "Expected upload details as JSON." }, 400);
  try {
    const body = await readBoundedRequestBody(request, { maxBytes: 8192 });
    let input: unknown;
    try {
      input = JSON.parse(Buffer.from(body ?? []).toString("utf8"));
    } catch {
      return json({ error: "Upload details are not valid JSON." }, 400);
    }
    if (cancel) {
      if (
        !input ||
        typeof input !== "object" ||
        Array.isArray(input) ||
        Object.keys(input).length !== 1 ||
        !("submissionToken" in input) ||
        typeof input.submissionToken !== "string"
      )
        return json({ error: "Invalid upload cancellation." }, 400);
      await cancelDocumentSubmission(
        auth.session.user.id,
        input.submissionToken
      );
      return json({ cancelled: true });
    }
    if (!isSubmissionMetadata(input))
      return json(
        { error: "Choose a supported document and output format." },
        400
      );
    return json(await prepareDocumentSubmission(auth.session.user.id, input));
  } catch (error) {
    if (
      error instanceof DocumentSubmissionError ||
      error instanceof RequestBodyError
    )
      return json({ error: error.message }, error.status);
    return json(
      { error: "Could not confirm the upload preparation. Please try again." },
      503
    );
  }
}
export const POST = (request: NextRequest) => handle(request, false);
export const DELETE = (request: NextRequest) => handle(request, true);
