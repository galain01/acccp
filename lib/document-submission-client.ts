import type { OutputTarget } from "./output-formats";

export interface PreparedDocumentSubmission {
  documentId: string;
  submissionToken: string;
  expiresAt: string;
  checksumSha256: string;
}
export class DocumentSubmissionError extends Error {
  constructor(message = "The upload could not be prepared. Please try again.") {
    super(message);
  }
}
const hashes = new WeakMap<File, Promise<string>>();
export function sourceChecksum(file: File): Promise<string> {
  let pending = hashes.get(file);
  if (!pending) {
    pending = file
      .arrayBuffer()
      .then((bytes) => crypto.subtle.digest("SHA-256", bytes))
      .then((hash) =>
        Array.from(new Uint8Array(hash), (value) =>
          value.toString(16).padStart(2, "0")
        ).join("")
      );
    hashes.set(file, pending);
  }
  return pending;
}

/** Preparation saves nothing. Always deliver its identity before observing a late abort. */
export async function prepareDocumentSubmission({
  file,
  sessionId,
  outputTarget,
  signal,
  onPrepared,
}: {
  file: File;
  sessionId: string;
  outputTarget: OutputTarget;
  signal: AbortSignal;
  onPrepared: (prepared: PreparedDocumentSubmission) => void;
}): Promise<PreparedDocumentSubmission> {
  signal.throwIfAborted();
  const checksumSha256 = await sourceChecksum(file);
  signal.throwIfAborted();
  const response = await fetch("/api/document-submission", {
    method: "POST",
    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId,
      filename: file.name,
      fileSizeBytes: file.size,
      checksumSha256,
      outputTarget,
    }),
  });
  if (!response.ok) throw new DocumentSubmissionError();
  const data: unknown = await response.json();
  if (
    !data ||
    typeof data !== "object" ||
    !("documentId" in data) ||
    typeof data.documentId !== "string" ||
    !/^[0-9a-f-]{36}$/i.test(data.documentId) ||
    !("submissionToken" in data) ||
    typeof data.submissionToken !== "string" ||
    !data.submissionToken ||
    data.submissionToken.length > 4096 ||
    !("expiresAt" in data) ||
    typeof data.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(data.expiresAt))
  )
    throw new DocumentSubmissionError();
  const prepared = {
    documentId: data.documentId,
    submissionToken: data.submissionToken,
    expiresAt: data.expiresAt,
    checksumSha256,
  };
  onPrepared(prepared);
  signal.throwIfAborted();
  return prepared;
}

export async function cancelDocumentSubmission(
  submissionToken: string
): Promise<void> {
  const response = await fetch("/api/document-submission", {
    method: "DELETE",
    signal: AbortSignal.timeout(10_000),
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ submissionToken }),
  });
  if (!response.ok)
    throw new DocumentSubmissionError(
      "The upload cancellation could not be confirmed."
    );
}
