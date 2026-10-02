import "server-only";
import {
  isPdfBuffer,
  MAX_PPTX_OUTPUT_SIZE_BYTES,
  MAX_PPTX_PREVIEW_PDF_SIZE_BYTES,
} from "./document-input";
import { createJobDiagnostic, describeJobDiagnostic } from "./job-diagnostics";

/** Only controlled messages escape this boundary. Worker bodies are never read as text. */
export class PowerPointRenderingError extends Error {
  readonly diagnostic = createJobDiagnostic({
    stage: "pptx_prepare",
    code: "pptx_render_failed",
  });
  constructor() {
    super(
      describeJobDiagnostic({
        version: 1,
        stage: "pptx_prepare",
        code: "pptx_render_failed",
      })
    );
    this.name = "PowerPointRenderingError";
  }
}

export interface PowerPointRenderingOptions {
  /** A short-lived read URL for an already stored, validated PPTX. */
  downloadUrl?: string;
}

function validatedDownloadUrl(value: string): string {
  try {
    const configuredOrigin = process.env.SUPABASE_URL ?? "";
    const project = new URL(configuredOrigin);
    const url = new URL(value);
    const local =
      !process.env.VERCEL &&
      process.env.NODE_ENV !== "production" &&
      (project.hostname === "localhost" ||
        project.hostname === "[::1]" ||
        /^127(?:\.\d{1,3}){3}$/.test(project.hostname));
    if (
      project.username ||
      project.password ||
      project.pathname !== "/" ||
      project.search ||
      project.hash ||
      (configuredOrigin !== project.origin &&
        configuredOrigin !== `${project.origin}/`) ||
      (!local &&
        (project.protocol !== "https:" ||
          project.port ||
          !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.supabase\.co$/.test(
            project.hostname
          ))) ||
      (local && !["http:", "https:"].includes(project.protocol)) ||
      url.origin !== project.origin ||
      url.username ||
      url.password ||
      url.hash ||
      value !== url.href ||
      !/^\/storage\/v1\/object\/sign\/documents\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\.pptx$/.test(
        url.pathname
      ) ||
      !/^\?token=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+&download=source\.pptx$/.test(
        url.search
      )
    )
      throw new PowerPointRenderingError();
    return url.href;
  } catch {
    throw new PowerPointRenderingError();
  }
}

/** PDF is a temporary visual reference; the repaired output remains the original OOXML package. */
export async function renderPowerPointToPdf(
  buffer: Buffer,
  timeoutMs = 60_000,
  options: PowerPointRenderingOptions = {}
): Promise<Buffer> {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000)
    throw new PowerPointRenderingError();
  if (!buffer.length || buffer.length > MAX_PPTX_OUTPUT_SIZE_BYTES)
    throw new PowerPointRenderingError();
  let endpoint: URL;
  try {
    endpoint = new URL(process.env.GOTENBERG_URL?.trim() ?? "");
  } catch {
    throw new PowerPointRenderingError();
  }
  const hostname = endpoint.hostname.replace(/\.$/, "");
  const loopback =
    hostname === "localhost" ||
    hostname === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/.test(hostname);
  if (
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    (loopback && process.env.VERCEL) ||
    (endpoint.protocol !== "https:" &&
      !(
        loopback &&
        endpoint.protocol === "http:" &&
        process.env.NODE_ENV !== "production"
      ))
  ) {
    throw new PowerPointRenderingError();
  }
  const username = process.env.GOTENBERG_USERNAME ?? "";
  const password = process.env.GOTENBERG_PASSWORD ?? "";
  if (
    !!username.trim() !== !!password.trim() ||
    (!loopback && !username.trim()) ||
    username.includes(":")
  ) {
    throw new PowerPointRenderingError();
  }
  endpoint.pathname = `${endpoint.pathname.replace(/\/+$/, "")}/forms/libreoffice/convert`;
  const form = new FormData();
  if (options.downloadUrl !== undefined) {
    form.append(
      "downloadFrom",
      JSON.stringify([{ url: validatedDownloadUrl(options.downloadUrl) }])
    );
  } else {
    form.append(
      "files",
      new Blob([new Uint8Array(buffer)], {
        type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      }),
      "source.pptx"
    );
  }
  form.append("exportHiddenSlides", "true");
  form.append("exportNotesPages", "false");
  form.append("exportNotes", "false");
  form.append("updateIndexes", "false");
  form.append("exportFormFields", "false");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      body: form,
      redirect: "manual",
      credentials: "omit",
      signal: controller.signal,
      headers: username.trim()
        ? {
            Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
          }
        : {},
    });
    if (
      !response.ok ||
      !response.body ||
      Number(response.headers.get("content-length") || 0) >
        MAX_PPTX_PREVIEW_PDF_SIZE_BYTES
    ) {
      void response.body?.cancel().catch(() => {});
      throw new PowerPointRenderingError();
    }
    const reader = response.body.getReader();
    const cancel = () => {
      void reader.cancel().catch(() => {});
    };
    if (controller.signal.aborted) {
      cancel();
      reader.releaseLock();
      throw new PowerPointRenderingError();
    }
    controller.signal.addEventListener("abort", cancel, { once: true });
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (controller.signal.aborted) throw new PowerPointRenderingError();
        if (done) break;
        size += value.length;
        if (size > MAX_PPTX_PREVIEW_PDF_SIZE_BYTES) {
          cancel();
          throw new PowerPointRenderingError();
        }
        chunks.push(value);
      }
    } finally {
      controller.signal.removeEventListener("abort", cancel);
      reader.releaseLock();
    }
    const pdf = Buffer.concat(chunks, size);
    if (!isPdfBuffer(pdf)) throw new PowerPointRenderingError();
    console.info(
      `[powerpoint] renderer transport=${options.downloadUrl === undefined ? "inline" : "stored"} pdf_bytes=${pdf.length}`
    );
    return pdf;
  } catch {
    throw new PowerPointRenderingError();
  } finally {
    clearTimeout(timer);
  }
}
