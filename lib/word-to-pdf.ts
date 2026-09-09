import "server-only";

import {
  DOCX_MIME_TYPE,
  isPdfBuffer,
  MAX_FILE_SIZE_BYTES,
} from "@/lib/document-input";

const RENDER_TIMEOUT_MS = 60_000;

/** Only controlled diagnostics from this module may reach an API response. */
export class WordToPdfError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = "WordToPdfError";
  }
}

function configurationError(): WordToPdfError {
  return new WordToPdfError(
    "Word conversion is not configured. Ask the administrator to check the Word conversion service, or export your document as a PDF and upload it.",
    503
  );
}

function rendererConfiguration(): { endpoint: URL; authorization?: string } {
  const baseUrl = process.env.GOTENBERG_URL?.trim();
  if (!baseUrl) throw configurationError();

  let endpoint: URL;
  try {
    endpoint = new URL(baseUrl);
  } catch {
    throw configurationError();
  }

  // Credentials and request options belong in server configuration, not in a
  // URL that transport errors, proxies, or middleware might print.
  if (
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  ) {
    throw configurationError();
  }
  const hostname = endpoint.hostname.replace(/\.$/, "");
  const loopback =
    hostname === "localhost" ||
    hostname === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/.test(hostname);
  if (loopback && process.env.VERCEL) throw configurationError();
  const localHttp =
    loopback &&
    endpoint.protocol === "http:" &&
    process.env.NODE_ENV !== "production";
  if (endpoint.protocol !== "https:" && !localHttp) {
    throw configurationError();
  }

  const username = process.env.GOTENBERG_USERNAME ?? "";
  const password = process.env.GOTENBERG_PASSWORD ?? "";
  const hasUsername = username.trim().length > 0;
  const hasPassword = password.trim().length > 0;
  if (
    hasUsername !== hasPassword ||
    (!loopback && !hasUsername) ||
    username.includes(":")
  ) {
    throw configurationError();
  }

  endpoint.pathname = `${endpoint.pathname.replace(/\/+$/, "")}/forms/libreoffice/convert`;
  return {
    endpoint,
    ...(hasUsername
      ? {
          authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
        }
      : {}),
  };
}

function responseError(status: number): WordToPdfError {
  if (status >= 300 && status < 400) {
    return new WordToPdfError(
      "The Word conversion service redirected the request. Ask the administrator to check its address, or upload a PDF instead.",
      502
    );
  }
  if (status === 401 || status === 403) return configurationError();
  if (status === 400 || status === 422) {
    return new WordToPdfError(
      "The Word document could not be rendered. Check that it opens in Word and is not password protected, or export it as a PDF and upload it.",
      422
    );
  }
  if (status === 413) {
    return new WordToPdfError(
      "The Word conversion service rejected the file size. Reduce the document size, or export it as a PDF under 4 MB and upload it.",
      413
    );
  }
  if (status === 429 || status === 503) {
    return new WordToPdfError(
      "The Word conversion service is busy. Try again shortly, or export your document as a PDF and upload it.",
      503
    );
  }
  return new WordToPdfError(
    "The Word conversion service could not complete the request. Try again, or export your document as a PDF and upload it.",
    502
  );
}

function renderedSizeError(): WordToPdfError {
  return new WordToPdfError(
    "The rendered PDF exceeds 4 MB. Reduce images or split the Word document, then try again.",
    413
  );
}

async function readPdf(
  response: Response,
  signal: AbortSignal
): Promise<Buffer> {
  const contentLength = response.headers.get("content-length");
  if (
    contentLength &&
    /^\d+$/.test(contentLength) &&
    Number(contentLength) > MAX_FILE_SIZE_BYTES
  ) {
    void response.body?.cancel().catch(() => {});
    throw renderedSizeError();
  }
  if (!response.body) {
    throw new WordToPdfError(
      "The Word conversion service returned no PDF. Try again, or export the document as a PDF and upload it.",
      502
    );
  }

  const reader = response.body.getReader();
  const cancelOnAbort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancelOnAbort, { once: true });
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      // Content-Length may be absent, incorrect, or compressed. Always enforce
      // the limit on the actual bytes, before retaining the next chunk.
      if (total > MAX_FILE_SIZE_BYTES) {
        void reader.cancel().catch(() => {});
        throw renderedSizeError();
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", cancelOnAbort);
    reader.releaseLock();
  }

  const pdf = Buffer.concat(chunks, total);
  if (!isPdfBuffer(pdf)) {
    throw new WordToPdfError(
      "The Word conversion service returned an invalid PDF. Try again, or export the document as a PDF and upload it.",
      502
    );
  }
  return pdf;
}

/** Render in a dedicated worker; source bytes and credentials stay server-side. */
export async function renderWordToPdf(
  buffer: Buffer,
  filename: string
): Promise<Buffer> {
  if (!filename.toLowerCase().endsWith(".docx")) {
    throw new WordToPdfError("Upload a .docx Word document or a PDF.", 415);
  }
  if (buffer.byteLength === 0) {
    throw new WordToPdfError("The Word document is empty.", 400);
  }
  if (buffer.byteLength > MAX_FILE_SIZE_BYTES) {
    throw new WordToPdfError(
      "File too large. Maximum upload size is 4 MB.",
      413
    );
  }
  const { endpoint, authorization } = rendererConfiguration();
  const form = new FormData();
  // The original filename can contain private information and never needs to
  // leave this app. Only one local upload is sent; no URLs or webhook fields.
  form.append(
    "files",
    new Blob([new Uint8Array(buffer)], { type: DOCX_MIME_TYPE }),
    "source.docx"
  );
  // Preserve authored indexes and flatten interactive controls in the PDF.
  form.append("updateIndexes", "false");
  form.append("exportFormFields", "false");
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new WordToPdfError(
          "Word conversion took too long. Try a smaller document, or export it as a PDF and upload it.",
          504
        )
      );
      controller.abort();
    }, RENDER_TIMEOUT_MS);
  });

  try {
    const render = async (): Promise<Buffer> => {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: authorization ? { Authorization: authorization } : {},
        body: form,
        redirect: "manual",
        credentials: "omit",
        signal: controller.signal,
      });
      if (!response.ok) {
        // Never read or forward worker diagnostics: they can contain source
        // text, private URLs, credentials, or document metadata.
        void response.body?.cancel().catch(() => {});
        throw responseError(response.status);
      }
      return readPdf(response, controller.signal);
    };
    return await Promise.race([render(), timeout]);
  } catch (error) {
    if (error instanceof WordToPdfError) throw error;
    throw new WordToPdfError(
      "Could not reach the Word conversion service. Try again, or export your document as a PDF and upload it.",
      502
    );
  } finally {
    if (timer) clearTimeout(timer);
  }
}
