import { auth } from "@/lib/auth";
import { toNextJsHandler } from "better-auth/next-js";
import {
  readBoundedRequestBody,
  RequestBodyError,
} from "@/lib/bounded-request-body";

const handlers = toNextJsHandler(auth.handler);
export const GET = handlers.GET;

export async function POST(request: Request) {
  try {
    const body = await readBoundedRequestBody(request, { maxBytes: 32 * 1024 });
    // Preserve Better Auth's original request and response contracts, including
    // cookies. This boundary only limits the bytes supplied to its parsers.
    return handlers.POST(
      body === null ? request : new Request(request, { body })
    );
  } catch (error) {
    if (error instanceof RequestBodyError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
