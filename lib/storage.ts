import { createClient } from "@supabase/supabase-js";

/**
 * Server-only Supabase Storage client.
 *
 * Uses the service role key, which bypasses storage RLS. Authentication is
 * better-auth rather than Supabase Auth, so requests carry no Supabase JWT and
 * an anon-key client would be treated as anonymous — granting it access would
 * mean opening the bucket to the public internet. Ownership is therefore
 * enforced in application code before every call into this module, exactly as
 * it is for the database.
 *
 * Never import this from a client component: the key grants full project access.
 */

const supabaseUrl = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl) throw new Error("Missing env var: SUPABASE_URL");
if (!serviceRoleKey)
  throw new Error("Missing env var: SUPABASE_SERVICE_ROLE_KEY");

export const DOCUMENTS_BUCKET = "documents";

export const DOCX_MIME_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const storage = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
}).storage.from(DOCUMENTS_BUCKET);

/** Object keys are grouped by session so a session's blobs can be swept together. */
export function sourcePdfKey(sessionId: string, documentId: string): string {
  return `${sessionId}/${documentId}/source.pdf`;
}

/** Retained so documents uploaded before PDF support can still be deleted. */
export function sourceDocxKey(sessionId: string, documentId: string): string {
  return `${sessionId}/${documentId}/source.docx`;
}

export function htmlOutputKey(sessionId: string, documentId: string): string {
  return `${sessionId}/${documentId}/output.html`;
}

export async function uploadObject(
  key: string,
  body: Buffer | string,
  contentType: string
): Promise<void> {
  const { error } = await storage.upload(key, body, {
    contentType,
    upsert: true, // Re-converting overwrites the previous output.
  });
  if (error)
    throw new Error(`Storage upload failed for ${key}: ${error.message}`);
}

export async function downloadObject(key: string): Promise<Buffer> {
  const { data, error } = await storage.download(key);
  if (error)
    throw new Error(`Storage download failed for ${key}: ${error.message}`);
  return Buffer.from(await data.arrayBuffer());
}

/** The bucket is private, so downloads need a short-lived signed url. */
export async function createSignedUrl(
  key: string,
  expiresInSeconds = 60 * 5
): Promise<string> {
  const { data, error } = await storage.createSignedUrl(key, expiresInSeconds);
  if (error) throw new Error(`Signing failed for ${key}: ${error.message}`);
  return data.signedUrl;
}

export async function removeObjects(keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  const { error } = await storage.remove(keys);
  if (error) throw new Error(`Storage delete failed: ${error.message}`);
}
