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
    // Next may proxy the incoming Request; the native copy constructor cannot
    // read that proxy's private state. Forward public HTTP fields and the bounded
    // bytes, retaining cookies, origin and cancellation for Better Auth.
    return handlers.POST(
      body === null
        ? request
        : new Request(request.url, {
            method: request.method,
            headers: request.headers,
            body,
            signal: request.signal,
          })
    );
  } catch (error) {
    if (error instanceof RequestBodyError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
