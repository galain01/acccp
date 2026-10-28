/** A safe HTTP error for a body rejected before parsing or authentication. */
export class RequestBodyError extends Error {
  constructor(
    readonly status: 400 | 408 | 413,
    message: string
  ) {
    super(message);
    this.name = "RequestBodyError";
  }
}

/** Count real bytes before any JSON/form parser can expand untrusted input. */
export async function readBoundedRequestBody(
  request: Request,
  { maxBytes, timeoutMs = 10_000 }: { maxBytes: number; timeoutMs?: number }
): Promise<Uint8Array<ArrayBuffer> | null> {
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1
  ) {
    throw new RangeError("Request body limits must be positive integers.");
  }
  if (!request.body) return null;
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = request.body.getReader();
  } catch {
    throw new RequestBodyError(400, "Unable to read request body.");
  }
  let completed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    if (request.signal.aborted) {
      throw new RequestBodyError(400, "Request body was interrupted.");
    }
    const declared = request.headers.get("content-length");
    if (
      declared !== null &&
      /^\d+$/.test(declared.trim()) &&
      Number(declared) > maxBytes
    ) {
      throw new RequestBodyError(413, "Request body is too large.");
    }
    const interrupted = new Promise<never>((_resolve, reject) => {
      onAbort = () =>
        reject(new RequestBodyError(400, "Request body was interrupted."));
      request.signal.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(
        () => reject(new RequestBodyError(408, "Request body timed out.")),
        timeoutMs
      );
    });
    const bytes = new Uint8Array(maxBytes);
    let size = 0;
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), interrupted]);
      if (done) {
        completed = true;
        return bytes.slice(0, size);
      }
      if (value.byteLength > maxBytes - size) {
        throw new RequestBodyError(413, "Request body is too large.");
      }
      bytes.set(value, size);
      size += value.byteLength;
    }
  } catch (error) {
    if (error instanceof RequestBodyError) throw error;
    throw new RequestBodyError(400, "Unable to read request body.");
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort) request.signal.removeEventListener("abort", onAbort);
    // Cancellation belongs to the input transport and can itself stall. The
    // request must finish within our deadline even if that promise never settles.
    if (!completed) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
