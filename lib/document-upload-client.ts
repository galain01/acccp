import {
  isPptxFilename,
  maxFileSizeForFilename,
  PPTX_MIME_TYPE,
} from "./document-input";
import {
  sourceChecksum,
  type PreparedDocumentSubmission,
} from "./document-submission-client";

export class DocumentUploadError extends Error {
  constructor(
    message = "The PowerPoint upload did not finish. Please try again."
  ) {
    super(message);
    this.name = "DocumentUploadError";
  }
}

/** Upload only to the scoped URL returned by the authenticated reservation endpoint. */
export async function uploadPowerPointDocument({
  file,
  sessionId,
  signal,
  onReserved,
  prepared,
}: {
  file: File;
  sessionId: string;
  signal: AbortSignal;
  onReserved: (documentId: string) => void;
  prepared?: PreparedDocumentSubmission;
}): Promise<string> {
  signal.throwIfAborted();
  if (
    !isPptxFilename(file.name) ||
    file.size < 1 ||
    file.size > maxFileSizeForFilename(file.name)
  ) {
    throw new DocumentUploadError(
      "Upload a PowerPoint (.pptx) file up to 25 MB."
    );
  }
  const checksumSha256 =
    prepared?.checksumSha256 ?? (await sourceChecksum(file));
  signal.throwIfAborted();
  // Let a reservation response finish even after cancellation so its known ID
  // can be deleted. The larger storage transfer remains abortable.
  const response = await fetch("/api/document-upload", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId,
      filename: file.name,
      fileSizeBytes: file.size,
      checksumSha256,
      ...(prepared ? { submissionToken: prepared.submissionToken } : {}),
    }),
  });
  if (response.status === 429)
    throw new DocumentUploadError(
      "Too many unfinished PowerPoint uploads. Finish an existing upload, or wait for unfinished upload windows to expire."
    );
  if (!response.ok)
    throw new DocumentUploadError(
      "The PowerPoint upload could not be prepared. Please try again."
    );
  const data: unknown = await response.json();
  if (
    !data ||
    typeof data !== "object" ||
    !("documentId" in data) ||
    typeof data.documentId !== "string" ||
    !data.documentId ||
    data.documentId.length > 100
  ) {
    throw new DocumentUploadError();
  }
  if (prepared && data.documentId !== prepared.documentId)
    throw new DocumentUploadError();
  onReserved(data.documentId);
  signal.throwIfAborted();
  if (prepared && "sourceReady" in data && data.sourceReady === true)
    return data.documentId;
  if (!("uploadUrl" in data) || typeof data.uploadUrl !== "string")
    throw new DocumentUploadError();
  let url: URL;
  try {
    url = new URL(data.uploadUrl);
  } catch {
    throw new DocumentUploadError();
  }
  if (
    url.username ||
    url.password ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      ))
  ) {
    throw new DocumentUploadError();
  }
  const uploaded = await fetch(url.href, {
    method: "PUT",
    body: file,
    headers: {
      "Content-Type": PPTX_MIME_TYPE,
      "x-upsert": "false",
      "cache-control": "max-age=0",
    },
    credentials: "omit",
    redirect: "error",
    cache: "no-store",
    signal,
  });
  if (!uploaded.ok) throw new DocumentUploadError();
  return data.documentId;
}
