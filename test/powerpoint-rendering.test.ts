import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { MAX_FILE_SIZE_BYTES } from "@/lib/document-input";
import {
  PowerPointRenderingError,
  renderPowerPointToPdf,
} from "@/lib/powerpoint-rendering";

const pptx = Buffer.from("PK\x03\x04private presentation package bytes");
const pdf = Buffer.from("%PDF-1.7\nslide preview\n%%EOF");
const fetchMock = vi.fn<typeof fetch>();
const controlledError = {
  name: "PowerPointRenderingError",
  diagnostic: { stage: "pptx_prepare", code: "pptx_render_failed" },
};

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("GOTENBERG_URL", "https://renderer.example.test");
  vi.stubEnv("GOTENBERG_USERNAME", "test-user");
  vi.stubEnv("GOTENBERG_PASSWORD", "test-password");
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("VERCEL", "1");
  fetchMock.mockReset().mockResolvedValue(new Response(pdf));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("PowerPoint renderer request privacy", () => {
  it("sends unchanged PPTX bytes with a generic filename, includes hidden slides, and excludes notes", async () => {
    expect(await renderPowerPointToPdf(pptx)).toEqual(pdf);
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
      "exportHiddenSlides",
      "exportNotesPages",
      "exportNotes",
      "updateIndexes",
      "exportFormFields",
    ]);
    expect(form.get("exportHiddenSlides")).toBe("true");
    expect(form.get("exportNotesPages")).toBe("false");
    expect(form.get("exportNotes")).toBe("false");
    expect(form.get("updateIndexes")).toBe("false");
    expect(form.get("exportFormFields")).toBe("false");
    const file = form.get("files") as File;
    expect(file.name).toBe("source.pptx");
    expect(file.type).toBe(
      "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    );
    expect(Buffer.from(await file.arrayBuffer())).toEqual(pptx);
  });

  it("preserves a configured reverse-proxy base path", async () => {
    vi.stubEnv("GOTENBERG_URL", " https://renderer.example.test/worker/ ");
    await renderPowerPointToPdf(pptx);
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
    "https://[::1]",
    "https://localhost.",
    "https://127.1",
    "https://127.0.0.2",
  ])("rejects unsafe deployed endpoint %s before uploading", async (url) => {
    vi.stubEnv("GOTENBERG_URL", url);
    await expect(renderPowerPointToPdf(pptx)).rejects.toMatchObject(
      controlledError
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["", ""],
    ["test-user", ""],
    ["", "test-password"],
    [" ", "test-password"],
    ["test-user", " "],
    ["wrong:username", "test-password"],
  ])(
    "requires complete remote server credentials",
    async (username, password) => {
      vi.stubEnv("GOTENBERG_USERNAME", username);
      vi.stubEnv("GOTENBERG_PASSWORD", password);
      await expect(renderPowerPointToPdf(pptx)).rejects.toMatchObject(
        controlledError
      );
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  it.each(["localhost", "127.0.0.1", "[::1]"])(
    "allows unauthenticated HTTP %s for local development",
    async (host) => {
      vi.stubEnv("NODE_ENV", "development");
      vi.stubEnv("VERCEL", "");
      vi.stubEnv("GOTENBERG_URL", `http://${host}:3001`);
      vi.stubEnv("GOTENBERG_USERNAME", "");
      vi.stubEnv("GOTENBERG_PASSWORD", "");
      await expect(renderPowerPointToPdf(pptx)).resolves.toEqual(pdf);
      expect(
        new Headers(fetchMock.mock.calls[0][1]?.headers).has("Authorization")
      ).toBe(false);
    }
  );

  it("rejects an incomplete local credential pair", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("GOTENBERG_URL", "http://localhost:3001");
    vi.stubEnv("GOTENBERG_PASSWORD", "");
    await expect(renderPowerPointToPdf(pptx)).rejects.toMatchObject(
      controlledError
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects HTTP loopback in a production process outside Vercel", async () => {
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("GOTENBERG_URL", "http://localhost:3001");
    await expect(renderPowerPointToPdf(pptx)).rejects.toMatchObject(
      controlledError
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("PowerPoint renderer response privacy and bounds", () => {
  it.each([301, 302, 303, 307, 308])(
    "does not follow redirect %s",
    async (status) => {
      fetchMock.mockResolvedValue(
        new Response("private presentation detail", {
          status,
          headers: { Location: "https://untrusted.example.test?private=token" },
        })
      );
      await expect(renderPowerPointToPdf(pptx)).rejects.toMatchObject(
        controlledError
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][1]?.redirect).toBe("manual");
    }
  );

  it.each([400, 401, 403, 413, 422, 429, 500, 503])(
    "hides private response details for status %s",
    async (status) => {
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      const response = new Response(
        "private.pptx test-password confidential notes",
        { status }
      );
      const text = vi.spyOn(response, "text");
      fetchMock.mockResolvedValue(response);
      const error = await renderPowerPointToPdf(pptx).catch((error) => error);
      expect(error).toBeInstanceOf(PowerPointRenderingError);
      expect(error).toMatchObject(controlledError);
      expect(JSON.stringify(error) + error.message).not.toMatch(
        /private\.pptx|test-password|confidential notes/
      );
      expect(text).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
    }
  );

  it("hides raw network errors and server credentials", async () => {
    fetchMock.mockRejectedValue(
      new Error(
        "secret https://test-user:test-password@renderer.example.test/private.pptx"
      )
    );
    const error = await renderPowerPointToPdf(pptx).catch((error) => error);
    expect(error).toMatchObject(controlledError);
    expect(JSON.stringify(error) + error.message).not.toMatch(
      /test-password|renderer\.example|private\.pptx|secret/
    );
  });

  it.each(["", "<html>private rendering diagnostic</html>"])(
    "rejects an invalid PDF response",
    async (body) => {
      fetchMock.mockResolvedValue(new Response(body));
      await expect(renderPowerPointToPdf(pptx)).rejects.toMatchObject(
        controlledError
      );
    }
  );

  it("rejects a missing response body", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await expect(renderPowerPointToPdf(pptx)).rejects.toMatchObject(
      controlledError
    );
  });

  it("rejects an oversized Content-Length before reading and cancels its body", async () => {
    const cancel = vi.fn();
    fetchMock.mockResolvedValue(
      new Response(new ReadableStream({ cancel }), {
        headers: { "Content-Length": String(MAX_FILE_SIZE_BYTES + 1) },
      })
    );
    await expect(renderPowerPointToPdf(pptx)).rejects.toMatchObject(
      controlledError
    );
    expect(cancel).toHaveBeenCalled();
  });

  it.each([undefined, "10"])(
    "enforces the byte limit with chunked Content-Length %s",
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
      await expect(renderPowerPointToPdf(pptx)).rejects.toMatchObject(
        controlledError
      );
      expect(cancel).toHaveBeenCalled();
    }
  );

  it("accepts a PDF exactly at the limit", async () => {
    const bytes = Buffer.alloc(MAX_FILE_SIZE_BYTES);
    pdf.copy(bytes);
    fetchMock.mockResolvedValue(new Response(bytes));
    const output = await renderPowerPointToPdf(pptx);
    expect(output.length).toBe(MAX_FILE_SIZE_BYTES);
    expect(output.equals(bytes)).toBe(true);
  });

  it("hides mid-stream failures", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(pdf);
        controller.error(new Error("private.pptx secret source text"));
      },
    });
    fetchMock.mockResolvedValue(new Response(stream));
    const error = await renderPowerPointToPdf(pptx).catch((error) => error);
    expect(error).toMatchObject(controlledError);
    expect(error.message).not.toMatch(/private|secret|source text/);
  });
});

describe("PowerPoint renderer time budgets", () => {
  it.each([0, -1, NaN, Infinity, 60_001])(
    "rejects invalid time budget %s before uploading",
    async (timeout) => {
      await expect(renderPowerPointToPdf(pptx, timeout)).rejects.toMatchObject(
        controlledError
      );
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  it.each([undefined, 1250])(
    "aborts a stalled fetch at the configured budget %s",
    async (timeout) => {
      vi.useFakeTimers();
      fetchMock.mockImplementation(
        (_url, options) =>
          new Promise((_resolve, reject) => {
            options?.signal?.addEventListener(
              "abort",
              () => reject(new DOMException("Aborted", "AbortError")),
              { once: true }
            );
          })
      );
      const pending = renderPowerPointToPdf(pptx, timeout);
      const assertion = expect(pending).rejects.toMatchObject(controlledError);
      await vi.advanceTimersByTimeAsync((timeout ?? 60_000) - 1);
      expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await assertion;
      expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    }
  );

  it("cancels a stalled response body within the same total request budget", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    fetchMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(
            () => resolve(new Response(new ReadableStream({ cancel }))),
            750
          );
        })
    );
    const pending = renderPowerPointToPdf(pptx, 1000);
    const assertion = expect(pending).rejects.toMatchObject(controlledError);
    await vi.advanceTimersByTimeAsync(999);
    expect(cancel).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects a response arriving at the abort boundary before starting to read its body", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    let bodyController: ReadableStreamDefaultController<Uint8Array>;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          bodyController = controller;
        },
        cancel,
      })
    );
    fetchMock.mockImplementation(
      (_url, options) =>
        new Promise((resolve) => {
          options?.signal?.addEventListener("abort", () => resolve(response), {
            once: true,
          });
        })
    );
    let settled = false;
    const pending = renderPowerPointToPdf(pptx, 1000).then(
      (value) => {
        settled = true;
        return value;
      },
      (error) => {
        settled = true;
        return error;
      }
    );
    try {
      await vi.advanceTimersByTimeAsync(1000);
      expect(settled).toBe(true);
      expect(await pending).toMatchObject(controlledError);
      expect(cancel).toHaveBeenCalledTimes(1);
    } finally {
      // Release the synthetic body even if this regression reappears.
      if (!cancel.mock.calls.length) bodyController!.close();
      await pending;
    }
  });

  it("clears its timer after successful rendering", async () => {
    vi.useFakeTimers();
    await expect(renderPowerPointToPdf(pptx, 1000)).resolves.toEqual(pdf);
    expect(vi.getTimerCount()).toBe(0);
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(false);
  });

  it.each([Buffer.alloc(0), Buffer.alloc(MAX_FILE_SIZE_BYTES + 1)])(
    "rejects invalid input length before uploading",
    async (bytes) => {
      await expect(renderPowerPointToPdf(bytes)).rejects.toMatchObject(
        controlledError
      );
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );
});
