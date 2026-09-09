import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { MAX_FILE_SIZE_BYTES } from "@/lib/document-input";
import { renderWordToPdf, WordToPdfError } from "@/lib/word-to-pdf";

const word = Buffer.from("PK\x03\x04test document bytes");
const pdf = Buffer.from("%PDF-1.7\nexample\n%%EOF");
const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("GOTENBERG_URL", "https://renderer.example.test");
  vi.stubEnv("GOTENBERG_USERNAME", "test-user");
  vi.stubEnv("GOTENBERG_PASSWORD", "test-password");
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("VERCEL", "1");
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(
    new Response(pdf, { headers: { "Content-Type": "application/pdf" } })
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("Word renderer request privacy", () => {
  it("sends exact DOCX bytes in one files field using a generic filename and server auth", async () => {
    const output = await renderWordToPdf(word, "private-student-record.DOCX");
    expect(output).toEqual(pdf);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(
      "https://renderer.example.test/forms/libreoffice/convert"
    );
    expect(options).toMatchObject({
      method: "POST",
      redirect: "manual",
      credentials: "omit",
    });
    expect(new Headers(options?.headers).get("Authorization")).toBe(
      `Basic ${Buffer.from("test-user:test-password").toString("base64")}`
    );
    const form = options?.body as FormData;
    expect([...form.keys()]).toEqual([
      "files",
      "updateIndexes",
      "exportFormFields",
    ]);
    expect(form.get("updateIndexes")).toBe("false");
    expect(form.get("exportFormFields")).toBe("false");
    const file = form.get("files") as File;
    expect(file.name).toBe("source.docx");
    expect(file.type).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    );
    expect(Buffer.from(await file.arrayBuffer())).toEqual(word);
    expect(String(url)).not.toContain("private-student-record");
  });

  it("supports a configured reverse-proxy base path without client-supplied options", async () => {
    vi.stubEnv("GOTENBERG_URL", "https://renderer.example.test/worker/");
    await renderWordToPdf(word, "file.docx");
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      "https://renderer.example.test/worker/forms/libreoffice/convert"
    );
  });

  it.each([
    "",
    "not-a-url",
    "http://renderer.example.test",
    "ftp://renderer.example.test",
    "https://user:private@renderer.example.test",
    "https://renderer.example.test?token=private",
    "https://renderer.example.test#private",
    "http://localhost:3001",
    "https://127.0.0.1",
    "https://localhost.",
    "https://127.1",
    "https://127.0.0.2",
  ])(
    "rejects unsafe or incomplete deployed URL %s before uploading",
    async (url) => {
      vi.stubEnv("GOTENBERG_URL", url);
      await expect(renderWordToPdf(word, "private.docx")).rejects.toMatchObject(
        { name: "WordToPdfError", status: 503 }
      );
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  it.each([
    ["", ""],
    ["test-user", ""],
    ["", "test-password"],
    ["wrong:username", "test-password"],
  ])(
    "requires a complete valid auth pair for remote rendering",
    async (username, password) => {
      vi.stubEnv("GOTENBERG_USERNAME", username);
      vi.stubEnv("GOTENBERG_PASSWORD", password);
      await expect(renderWordToPdf(word, "file.docx")).rejects.toMatchObject({
        status: 503,
      });
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  it.each(["localhost", "127.0.0.1", "[::1]"])(
    "allows HTTP %s only for local development",
    async (host) => {
      vi.stubEnv("NODE_ENV", "development");
      vi.stubEnv("VERCEL", "");
      vi.stubEnv("GOTENBERG_URL", `http://${host}:3001`);
      vi.stubEnv("GOTENBERG_USERNAME", "");
      vi.stubEnv("GOTENBERG_PASSWORD", "");
      await expect(renderWordToPdf(word, "file.docx")).resolves.toEqual(pdf);
      expect(
        new Headers(fetchMock.mock.calls[0][1]?.headers).has("Authorization")
      ).toBe(false);
    }
  );

  it("requires both credentials together even for a local renderer", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("GOTENBERG_URL", "http://localhost:3001");
    vi.stubEnv("GOTENBERG_PASSWORD", "");
    await expect(renderWordToPdf(word, "file.docx")).rejects.toMatchObject({
      status: 503,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects local HTTP for a production process outside Vercel", async () => {
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("GOTENBERG_URL", "http://localhost:3001");
    await expect(renderWordToPdf(word, "file.docx")).rejects.toMatchObject({
      status: 503,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("Word renderer bounded responses", () => {
  it.each([301, 302, 303, 307, 308])(
    "refuses redirect %s without following its location",
    async (status) => {
      fetchMock.mockResolvedValue(
        new Response("private worker response", {
          status,
          headers: { Location: "https://untrusted.example.test?private=token" },
        })
      );
      await expect(renderWordToPdf(word, "private.docx")).rejects.toMatchObject(
        { status: 502, message: expect.stringContaining("redirected") }
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][1]?.redirect).toBe("manual");
    }
  );

  it.each([
    [400, 422],
    [422, 422],
    [401, 503],
    [403, 503],
    [413, 413],
    [429, 503],
    [503, 503],
    [500, 502],
  ])(
    "maps worker status %s to a controlled error %s without forwarding private diagnostics",
    async (upstream, expected) => {
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      const response = new Response(
        "private.docx test-password confidential source text",
        { status: upstream }
      );
      const bodyRead = vi.spyOn(response, "text");
      fetchMock.mockResolvedValue(response);
      const error = await renderWordToPdf(word, "private.docx").catch(
        (error) => error
      );
      expect(error).toBeInstanceOf(WordToPdfError);
      expect(error.status).toBe(expected);
      expect(error.message).not.toMatch(
        /private\.docx|test-password|confidential source text/
      );
      expect(bodyRead).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
    }
  );

  it("hides raw network failures", async () => {
    fetchMock.mockRejectedValue(
      new Error(
        "secret https://test-user:test-password@renderer.example.test/private.docx"
      )
    );
    const error = await renderWordToPdf(word, "private.docx").catch(
      (error) => error
    );
    expect(error).toMatchObject({ status: 502 });
    expect(error.message).not.toMatch(
      /test-password|renderer\.example|private\.docx|secret/
    );
  });

  it.each(["", "<html>private worker diagnostic</html>"])(
    "rejects an invalid PDF response",
    async (body) => {
      fetchMock.mockResolvedValue(new Response(body));
      await expect(renderWordToPdf(word, "file.docx")).rejects.toMatchObject({
        status: 502,
        message: expect.stringContaining("invalid PDF"),
      });
    }
  );

  it("rejects a missing response body", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await expect(renderWordToPdf(word, "file.docx")).rejects.toMatchObject({
      status: 502,
      message: expect.stringContaining("no PDF"),
    });
  });

  it("rejects an oversized Content-Length before reading any PDF bytes", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream({ cancel });
    fetchMock.mockResolvedValue(
      new Response(stream, {
        headers: { "Content-Length": String(MAX_FILE_SIZE_BYTES + 1) },
      })
    );
    await expect(renderWordToPdf(word, "file.docx")).rejects.toMatchObject({
      status: 413,
    });
    expect(cancel).toHaveBeenCalled();
  });

  it.each([undefined, "10"])(
    "caps chunked PDF bytes regardless of Content-Length %s",
    async (contentLength) => {
      const cancel = vi.fn();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(MAX_FILE_SIZE_BYTES));
          controller.enqueue(new Uint8Array(1));
        },
        cancel,
      });
      fetchMock.mockResolvedValue(
        new Response(
          stream,
          contentLength ? { headers: { "Content-Length": contentLength } } : {}
        )
      );
      await expect(renderWordToPdf(word, "file.docx")).rejects.toMatchObject({
        status: 413,
      });
      expect(cancel).toHaveBeenCalled();
    }
  );

  it("accepts a PDF exactly at the size limit", async () => {
    const bytes = Buffer.alloc(MAX_FILE_SIZE_BYTES);
    pdf.copy(bytes);
    fetchMock.mockResolvedValue(new Response(bytes));
    const output = await renderWordToPdf(word, "file.docx");
    expect(output.byteLength).toBe(MAX_FILE_SIZE_BYTES);
    expect(output.equals(bytes)).toBe(true);
  });

  it("aborts a stalled request after 60 seconds", async () => {
    vi.useFakeTimers();
    fetchMock.mockReturnValue(new Promise(() => {}));
    const pending = renderWordToPdf(word, "file.docx");
    const assertion = expect(pending).rejects.toMatchObject({ status: 504 });
    await vi.advanceTimersByTimeAsync(60_000);
    await assertion;
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it("also times out a response whose PDF stream stalls", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    fetchMock.mockResolvedValue(new Response(new ReadableStream({ cancel })));
    const pending = renderWordToPdf(word, "file.docx");
    const assertion = expect(pending).rejects.toMatchObject({ status: 504 });
    await vi.advanceTimersByTimeAsync(60_000);
    await assertion;
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(cancel).toHaveBeenCalled();
  });

  it.each([
    [Buffer.alloc(0), "file.docx", 400],
    [word, "file.doc", 415],
    [Buffer.alloc(MAX_FILE_SIZE_BYTES + 1), "file.docx", 413],
  ])(
    "rejects invalid input before contacting the worker",
    async (bytes, filename, status) => {
      await expect(
        renderWordToPdf(bytes as Buffer, filename as string)
      ).rejects.toMatchObject({ status });
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );
});
