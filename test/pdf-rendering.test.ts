import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import * as childProcess from "node:child_process";
import {
  PDFDocument,
  PDFName,
  PDFOperator,
  PDFOperatorNames,
  StandardFonts,
  rgb,
} from "pdf-lib";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import {
  PDF_RENDERING_LIMITS,
  PdfRenderingError,
  renderPdfPages,
} from "../lib/pdf-rendering";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

beforeEach(async () => {
  const actual =
    await vi.importActual<typeof import("node:child_process")>(
      "node:child_process"
    );
  vi.mocked(childProcess.spawn).mockReset().mockImplementation(actual.spawn);
});

async function makePdf(pageCount = 1, size: [number, number] = [300, 300]) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let n = 1; n <= pageCount; n++) {
    const page = pdf.addPage(size);
    page.drawRectangle({
      x: 100,
      y: 100,
      width: 100,
      height: 100,
      color: rgb(1, 0, 0),
    });
    page.drawText(`Physical page ${n}`, { x: 20, y: 250, size: 16, font });
  }
  return Buffer.from(await pdf.save());
}

function declaredImage(
  pdf: PDFDocument,
  width: number,
  height: number,
  imageSubtype = true
) {
  return pdf.context.register(
    pdf.context.flateStream(new Uint8Array([0]), {
      ...(imageSubtype
        ? { Type: PDFName.of("XObject"), Subtype: PDFName.of("Image") }
        : {}),
      Width: width,
      Height: height,
      BitsPerComponent: 8,
      ColorSpace: PDFName.of("DeviceGray"),
    })
  );
}

function fakeChild() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
    pid: 1234,
  });
  vi.mocked(childProcess.spawn).mockReturnValue(
    child as unknown as ReturnType<typeof childProcess.spawn>
  );
  return child;
}

async function renderingFailure(
  pending: Promise<unknown>
): Promise<PdfRenderingError> {
  const error: unknown = await pending.then(
    () => null,
    (error: unknown) => error
  );
  expect(error).toBeInstanceOf(PdfRenderingError);
  return error as PdfRenderingError;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("PDF visual rendering in the real child process", () => {
  it("renders every page in order with visible vector pixels and matching text", async () => {
    const result = await renderPdfPages(await makePdf(3));
    expect(result.pageCount).toBe(3);
    for (const [index, page] of result.pages.entries()) {
      expect(page.pageNumber).toBe(index + 1);
      expect([page.width, page.height]).toEqual([600, 600]);
      expect(page.text).toContain(`Physical page ${index + 1}`);
      const decoded = await loadImage(page.png);
      const canvas = createCanvas(page.width, page.height);
      const context = canvas.getContext("2d");
      context.drawImage(decoded, 0, 0);
      expect([...context.getImageData(300, 300, 1, 1).data]).toEqual([
        255, 0, 0, 255,
      ]);
    }
  }, 15_000);

  it("keeps empty text for an image-only/vector-only page", async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage([100, 100]).drawRectangle({
      x: 20,
      y: 20,
      width: 60,
      height: 60,
      color: rgb(0, 0, 1),
    });
    const result = await renderPdfPages(Buffer.from(await pdf.save()));
    expect(result.pages[0].text).toBe("");
  }, 15_000);

  it("reduces oversized page dimensions before allocating a canvas", async () => {
    const result = await renderPdfPages(await makePdf(1, [14_400, 14_400]));
    const page = result.pages[0];
    expect(page.width * page.height).toBeLessThanOrEqual(
      PDF_RENDERING_LIMITS.maxPagePixels
    );
    expect(page.width).toBeLessThanOrEqual(
      PDF_RENDERING_LIMITS.maxPageDimension
    );
  }, 15_000);

  it("rejects the whole document above the page limit", async () => {
    const error = await renderingFailure(renderPdfPages(await makePdf(61)));
    expect(error.diagnostic).toMatchObject({
      version: 1,
      stage: "pdf_render",
      code: "pdf_page_limit",
    });
    expect(error.diagnostic).not.toHaveProperty("pageNumber");
  }, 15_000);

  it("rejects oversized embedded images instead of returning a page with the image omitted", async () => {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([300, 300]);
    const canvas = createCanvas(3000, 3000);
    const context = canvas.getContext("2d");
    context.fillStyle = "#ff0000";
    context.fillRect(0, 0, 3000, 3000);
    const image = await pdf.embedPng(await canvas.encode("png"));
    page.drawImage(image, { x: 0, y: 0, width: 200, height: 200 });
    const error = await renderingFailure(
      renderPdfPages(Buffer.from(await pdf.save()))
    );
    expect(error.diagnostic.code).toBe("pdf_image_limit");
    expect(error.diagnostic).not.toHaveProperty("pageNumber");
  }, 15_000);

  it("does not turn optional oversized text into truncated verification evidence", async () => {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    pdf
      .addPage([300, 300])
      .drawText("x".repeat(100_001), { x: 0, y: 100, size: 0.001, font });
    const result = await renderPdfPages(Buffer.from(await pdf.save()));
    expect(result.pages[0].png.length).toBeGreaterThan(24);
    expect(result.pages[0].text).toBeNull();
  }, 15_000);

  it.each(["SMask", "Mask"])(
    "rejects an oversized %s even in unreferenced nested objects",
    async (key) => {
      const pdf = await PDFDocument.create();
      pdf.addPage([100, 100]);
      const mask = declaredImage(pdf, 3000, 3000, false);
      const image = declaredImage(pdf, 1, 1);
      const nested = pdf.context.obj({ [key]: mask });
      pdf.context.register(pdf.context.obj({ Nested: nested, Image: image }));
      // These unreferenced streams are not decoded by PDF.js: rejection therefore
      // demonstrates preflight coverage rather than a downstream decode failure.
      await expect(
        renderPdfPages(Buffer.from(await pdf.save()))
      ).rejects.toMatchObject({ diagnostic: { code: "pdf_image_limit" } });
    }
  );

  it("rejects base/mask axis expansion even when their individual areas fit", async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage([100, 100]);
    const mask = declaredImage(pdf, 1000, 4000);
    pdf.context.register(
      pdf.context.flateStream(new Uint8Array([0]), {
        Type: PDFName.of("XObject"),
        Subtype: PDFName.of("Image"),
        Width: 4000,
        Height: 1000,
        BitsPerComponent: 8,
        ColorSpace: PDFName.of("DeviceGray"),
        SMask: mask,
      })
    );
    await expect(
      renderPdfPages(Buffer.from(await pdf.save()))
    ).rejects.toMatchObject({ diagnostic: { code: "pdf_image_limit" } });
  });

  it("rejects aggregate declared image pixels before decoding unused streams", async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage([100, 100]);
    for (let i = 0; i < 9; i++) declaredImage(pdf, 2000, 2000);
    await expect(
      renderPdfPages(Buffer.from(await pdf.save()))
    ).rejects.toMatchObject({ diagnostic: { code: "pdf_image_limit" } });
  });

  it("rejects duplicate object definitions that hide the xref-selected image from preflight", async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage([100, 100]);
    const ref = declaredImage(pdf, 3000, 3000);
    const original = Buffer.from(await pdf.save({ useObjectStreams: false }));
    // The original xref still selects the 9MP definition. A sequential parser
    // instead sees this appended 1px replacement last and overwrites the object.
    const duplicate = Buffer.from(
      `\n${ref.objectNumber} ${ref.generationNumber} obj\n<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /BitsPerComponent 8 /ColorSpace /DeviceGray /Length 1 >>\nstream\nX\nendstream\nendobj\n`
    );
    await expect(
      renderPdfPages(Buffer.concat([original, duplicate]))
    ).rejects.toMatchObject({ diagnostic: { code: "pdf_invalid" } });
  });

  it("renders a valid embedded image and its transparency mask", async () => {
    const pdf = await PDFDocument.create();
    const source = createCanvas(20, 20);
    const sourceContext = source.getContext("2d");
    sourceContext.fillStyle = "rgba(255, 0, 0, 0.5)";
    sourceContext.fillRect(0, 0, 20, 20);
    const embedded = await pdf.embedPng(await source.encode("png"));
    pdf
      .addPage([100, 100])
      .drawImage(embedded, { x: 0, y: 0, width: 100, height: 100 });
    const rendered = await renderPdfPages(Buffer.from(await pdf.save()));
    const target = createCanvas(200, 200);
    const context = target.getContext("2d");
    context.drawImage(await loadImage(rendered.pages[0].png), 0, 0);
    const [red, green, blue, alpha] = context.getImageData(100, 100, 1, 1).data;
    expect(red).toBe(255);
    expect(green).toBeGreaterThanOrEqual(120);
    expect(green).toBeLessThanOrEqual(135);
    expect(blue).toBe(green);
    expect(alpha).toBe(255);
  });

  it("returns only a safe error for malformed source content", async () => {
    const error = await renderingFailure(
      renderPdfPages(Buffer.from("%PDF-secret-document-text-not-a-real-pdf"))
    );
    expect(error.diagnostic.code).toBe("pdf_invalid");
    expect(error.diagnostic).not.toHaveProperty("pageNumber");
    expect(error.message).not.toMatch(
      /secret-document|not-a-real-pdf|Error:|node_modules/
    );
    expect(error.diagnostic.elapsedMs).toEqual(expect.any(Number));
  }, 15_000);

  it("distinguishes encryption detected by the PDF parser", async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage([100, 100]);
    // The parser rejects the encryption dictionary before decoding page data.
    pdf.context.trailerInfo.Encrypt = pdf.context.register(
      pdf.context.obj({
        Filter: PDFName.of("Standard"),
        V: 1,
        R: 2,
        P: -4,
      })
    );
    const error = await renderingFailure(
      renderPdfPages(Buffer.from(await pdf.save()))
    );
    expect(error.diagnostic.code).toBe("pdf_password");
    expect(error.diagnostic).not.toHaveProperty("pageNumber");
  });

  it("reports the declared-object complexity guard without guessing a page", async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage([100, 100]);
    pdf.context.register(pdf.context.obj(Array(100_001).fill(0)));
    const error = await renderingFailure(
      renderPdfPages(Buffer.from(await pdf.save()))
    );
    expect(error.diagnostic.code).toBe("pdf_complexity_limit");
    expect(error.diagnostic).not.toHaveProperty("pageNumber");
  }, 15_000);

  it("reports the physical page when PDF.js warns that page content was omitted", async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage([100, 100]);
    const page = pdf.addPage([100, 100]);
    page.pushOperators(
      PDFOperator.of(PDFOperatorNames.DrawObject, [
        PDFName.of("private-missing-image"),
      ])
    );
    const error = await renderingFailure(
      renderPdfPages(Buffer.from(await pdf.save()))
    );
    expect(error.diagnostic).toMatchObject({
      code: "pdf_render_warning",
      pageNumber: 2,
    });
    expect(error.message).toContain("PDF page 2");
    expect(error.message).not.toContain("private-missing-image");
    expect(JSON.stringify(error.diagnostic)).not.toContain("private");
  });
});

describe("renderer process boundaries", () => {
  it("keeps the no-argument error constructor compatible and supplies safe diagnostics", () => {
    const error = new PdfRenderingError();
    expect(error).toBeInstanceOf(Error);
    expect(error.diagnostic).toEqual({
      version: 1,
      stage: "pdf_render",
      code: "unknown_error",
    });
  });

  it.each([
    ["missing metadata", undefined],
    [
      "an invalid occurrence ID",
      {
        status: "complete",
        figures: [{ id: "p99-figure1", alt: "Authored", bounds: null }],
      },
    ],
    [
      "out-of-page bounds",
      {
        status: "complete",
        figures: [
          {
            id: "p1-figure1",
            alt: "Authored",
            bounds: { x: 0.9, y: 0.2, width: 0.4, height: 0.2 },
          },
        ],
      },
    ],
    [
      "a truncated-limit violation",
      {
        status: "complete",
        figures: [{ id: "p1-figure1", alt: "x".repeat(8001), bounds: null }],
      },
    ],
  ])(
    "treats %s as unavailable descriptions while retaining a valid rendered page",
    async (_, metadata) => {
      const png = await createCanvas(1, 1).encode("png");
      const child = fakeChild();
      const pending = renderPdfPages(Buffer.from("%PDF-test"));
      child.stdout.emit(
        "data",
        Buffer.from(
          JSON.stringify({
            ok: true,
            pageCount: 1,
            pages: [
              {
                pageNumber: 1,
                width: 1,
                height: 1,
                png: png.toString("base64"),
                text: "",
                imageAlternatives: metadata,
              },
            ],
          })
        )
      );
      child.emit("close", 0);
      const result = await pending;
      expect(result.pages[0].png).toEqual(png);
      expect(result.pages[0].imageAlternatives).toEqual({
        status: "unavailable",
        figures: [],
      });
    }
  );

  it("rejects invalid and oversized inputs before spawning", async () => {
    const spawn = vi.mocked(childProcess.spawn);
    await expect(
      renderPdfPages(Buffer.from("not a PDF"))
    ).rejects.toMatchObject({ diagnostic: { code: "pdf_invalid" } });
    await expect(
      renderPdfPages(Buffer.alloc(4 * 1024 * 1024 + 1))
    ).rejects.toMatchObject({ diagnostic: { code: "pdf_invalid" } });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("passes only a fixed mode and public Windows OS path, with data confined to stdin", async () => {
    const child = fakeChild();
    const pending = renderPdfPages(Buffer.from("%PDF-synthetic-secret"));
    const [, args, options] = vi.mocked(childProcess.spawn).mock.calls[0];
    expect(args?.join(" ")).not.toContain("synthetic-secret");
    expect(args).toContain("--permission");
    expect(args).toContain("--allow-addons");
    expect(
      Object.keys(options?.env ?? {}).every(
        (key) => key === "SystemRoot" || key === "NODE_ENV"
      )
    ).toBe(true);
    expect(options?.env?.NODE_ENV).toBe("production");
    expect(options?.windowsHide).toBe(true);
    child.stdout.emit("data", Buffer.from('{"ok":false,"code":"pdf_invalid"}'));
    child.emit("close", 1);
    await expect(pending).rejects.toMatchObject({
      diagnostic: { code: "pdf_invalid" },
    });
  });

  it("force-kills on deadline and waits for close before rejecting", async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    let settled = false;
    const pending = renderPdfPages(Buffer.from("%PDF-test")).catch((error) => {
      settled = true;
      return error;
    });
    await vi.advanceTimersByTimeAsync(PDF_RENDERING_LIMITS.timeoutMs);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(settled).toBe(false);
    // Killing the worker can emit a later pipe error; it must not erase timeout.
    child.stdin.emit("error", new Error("private pipe failure"));
    child.emit("close", null);
    expect(await pending).toMatchObject({
      diagnostic: { code: "pdf_timeout", elapsedMs: 30_000 },
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("caps private stderr, kills, and never exposes the native error", async () => {
    const child = fakeChild();
    const pending = renderPdfPages(Buffer.from("%PDF-test"));
    child.stderr.emit(
      "data",
      Buffer.alloc(PDF_RENDERING_LIMITS.maxStderrBytes + 1, "x")
    );
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    child.emit("close", 1);
    await expect(pending).rejects.toMatchObject({
      diagnostic: { code: "pdf_worker_failed" },
    });
  });

  it("caps stdout even when a child emits unlimited data", async () => {
    const child = fakeChild();
    const pending = renderPdfPages(Buffer.from("%PDF-test"));
    const chunk = Buffer.alloc(1024 * 1024);
    for (let n = 0; n < 40; n++) child.stdout.emit("data", chunk);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    child.emit("close", 1);
    await expect(pending).rejects.toMatchObject({
      diagnostic: { code: "pdf_output_limit" },
    });
  });

  it("rejects malformed child output without retaining its text", async () => {
    const child = fakeChild();
    const pending = renderPdfPages(Buffer.from("%PDF-test"));
    child.stdout.emit("data", Buffer.from("private source text; invalid JSON"));
    child.emit("close", 0);
    const error = await renderingFailure(pending);
    expect(error.diagnostic.code).toBe("pdf_protocol_error");
    expect(error.message).not.toContain("private source text");
  });

  it.each([0, 1])(
    "retains a valid bounded page failure with exit status %i",
    async (exitCode) => {
      const child = fakeChild();
      const pending = renderPdfPages(Buffer.from("%PDF-test"));
      child.stdout.emit(
        "data",
        Buffer.from('{"ok":false,"code":"pdf_page_failed","pageNumber":3}')
      );
      child.emit("close", exitCode);
      const error = await renderingFailure(pending);
      expect(error.diagnostic).toMatchObject({
        code: "pdf_page_failed",
        pageNumber: 3,
      });
      expect(error.message).toContain("PDF page 3");
    }
  );

  it.each([
    { ok: false },
    { ok: false, code: "private-source-text" },
    { ok: false, code: "pdf_page_failed", pageNumber: 0 },
    { ok: false, code: "pdf_page_failed", pageNumber: 61 },
    { ok: false, code: "pdf_page_failed", pageNumber: 1.5 },
    { ok: false, code: "pdf_page_failed", pageNumber: "2" },
    { ok: false, code: "pdf_page_failed", message: "private-source-text" },
  ])(
    "rejects an invalid failure protocol without retaining arbitrary data: %j",
    async (value) => {
      const child = fakeChild();
      const pending = renderPdfPages(Buffer.from("%PDF-test"));
      child.stdout.emit("data", Buffer.from(JSON.stringify(value)));
      child.emit("close", 1);
      const error = await renderingFailure(pending);
      expect(error.diagnostic.code).toBe("pdf_protocol_error");
      expect(error.diagnostic).not.toHaveProperty("pageNumber");
      expect(JSON.stringify(error)).not.toContain("private-source-text");
    }
  );

  it("requires a small failure payload even when it contains a valid code", async () => {
    const child = fakeChild();
    const pending = renderPdfPages(Buffer.from("%PDF-test"));
    child.stdout.emit(
      "data",
      Buffer.from('{"ok":false,"code":"pdf_invalid"}' + " ".repeat(512))
    );
    child.emit("close", 1);
    await expect(pending).rejects.toMatchObject({
      diagnostic: { code: "pdf_protocol_error" },
    });
  });

  it("reports a worker failure for an empty nonzero exit", async () => {
    const child = fakeChild();
    const pending = renderPdfPages(Buffer.from("%PDF-test"));
    child.emit("close", 1);
    await expect(pending).rejects.toMatchObject({
      diagnostic: { code: "pdf_worker_failed" },
    });
  });

  it("does not accept a claimed success after a worker exits unsuccessfully", async () => {
    const child = fakeChild();
    const pending = renderPdfPages(Buffer.from("%PDF-test"));
    child.stdout.emit(
      "data",
      Buffer.from('{"ok":true,"pageCount":1,"pages":[]}')
    );
    child.emit("close", 1);
    await expect(pending).rejects.toMatchObject({
      diagnostic: { code: "pdf_worker_failed" },
    });
  });

  it("does not expose a process launch exception", async () => {
    vi.mocked(childProcess.spawn).mockImplementationOnce(() => {
      throw new Error("private source path and credentials");
    });
    const error = await renderingFailure(
      renderPdfPages(Buffer.from("%PDF-test"))
    );
    expect(error.diagnostic.code).toBe("pdf_worker_failed");
    expect(error.message).not.toMatch(/private|credentials/);
  });
});
