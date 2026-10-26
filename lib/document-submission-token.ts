import "server-only";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import {
  isSupportedDocumentFilename,
  maxFileSizeForFilename,
} from "./document-input";
import {
  isOutputTarget,
  isSupportedOutputForFilename,
  type OutputTarget,
} from "./output-formats";

export const SUBMISSION_WINDOW_MS = 10 * 60_000;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ANY_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DOMAIN = "acccp:document-submission:v1\0";

export class DocumentSubmissionError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly documentId?: string,
    readonly outputTarget?: OutputTarget
  ) {
    super(message);
  }
}
export interface SubmissionMetadata {
  sessionId: string;
  filename: string;
  fileSizeBytes: number;
  checksumSha256: string;
  outputTarget: OutputTarget;
}
export interface SubmissionClaims extends SubmissionMetadata {
  version: 1;
  documentId: string;
  userId: string;
  issuedAt: number;
  expiresAt: number;
}

export function isSubmissionMetadata(
  value: unknown
): value is SubmissionMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    Object.keys(v).length === 5 &&
    typeof v.sessionId === "string" &&
    ANY_UUID.test(v.sessionId) &&
    typeof v.filename === "string" &&
    v.filename.length <= 240 &&
    v.filename.trim() === v.filename &&
    /^[^\x00-\x1f\x7f/\\]+$/.test(v.filename) &&
    isSupportedDocumentFilename(v.filename) &&
    Number.isSafeInteger(v.fileSizeBytes) &&
    Number(v.fileSizeBytes) > 0 &&
    Number(v.fileSizeBytes) <= maxFileSizeForFilename(v.filename) &&
    typeof v.checksumSha256 === "string" &&
    /^[a-f0-9]{64}$/.test(v.checksumSha256) &&
    isOutputTarget(v.outputTarget) &&
    isSupportedOutputForFilename(v.filename, v.outputTarget)
  );
}
function signature(body: string): Buffer {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret || Buffer.byteLength(secret) < 32)
    throw new DocumentSubmissionError(
      "Upload preparation is temporarily unavailable.",
      503
    );
  return createHmac("sha256", secret).update(DOMAIN).update(body).digest();
}
export function issueSubmissionToken(
  userId: string,
  input: SubmissionMetadata
) {
  if (!ANY_UUID.test(userId) || !isSubmissionMetadata(input))
    throw new DocumentSubmissionError(
      "Choose a supported document and output format."
    );
  const issuedAt = Date.now();
  const claims: SubmissionClaims = {
    version: 1,
    documentId: randomUUID(),
    userId,
    sessionId: input.sessionId,
    filename: input.filename,
    fileSizeBytes: input.fileSizeBytes,
    checksumSha256: input.checksumSha256,
    outputTarget: input.outputTarget,
    issuedAt,
    expiresAt: issuedAt + SUBMISSION_WINDOW_MS,
  };
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return {
    documentId: claims.documentId,
    submissionToken: `${body}.${signature(body).toString("base64url")}`,
    expiresAt: new Date(claims.expiresAt).toISOString(),
  };
}
export function readSubmissionToken(
  token: string,
  userId: string,
  options: { allowExpired?: boolean } = {}
): SubmissionClaims {
  if (
    typeof token !== "string" ||
    token.length > 4096 ||
    !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token)
  )
    throw new DocumentSubmissionError("Invalid upload preparation.");
  const [body, supplied] = token.split(".");
  const expected = signature(body);
  const actual = Buffer.from(supplied, "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
    throw new DocumentSubmissionError("Invalid upload preparation.", 403);
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    throw new DocumentSubmissionError("Invalid upload preparation.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new DocumentSubmissionError("Invalid upload preparation.");
  const v = value as Record<string, unknown>;
  const {
    version,
    documentId,
    userId: tokenOwner,
    issuedAt,
    expiresAt,
    ...metadata
  } = v;
  if (
    version !== 1 ||
    typeof documentId !== "string" ||
    !UUID.test(documentId) ||
    tokenOwner !== userId ||
    !isSubmissionMetadata(metadata) ||
    !Number.isSafeInteger(issuedAt) ||
    Number(issuedAt) <= 0 ||
    !Number.isSafeInteger(expiresAt) ||
    Number(expiresAt) !== Number(issuedAt) + SUBMISSION_WINDOW_MS ||
    Number(issuedAt) > Date.now() + 30_000
  )
    throw new DocumentSubmissionError("Invalid upload preparation.", 403);
  if (!options.allowExpired && Number(expiresAt) <= Date.now())
    throw new DocumentSubmissionError(
      "This upload preparation has expired. Select the file again.",
      410
    );
  return {
    version: 1,
    documentId,
    userId,
    issuedAt: Number(issuedAt),
    expiresAt: Number(expiresAt),
    ...metadata,
  };
}
