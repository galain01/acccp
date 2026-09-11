import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import * as childProcess from "node:child_process";
import { PDFDocument, PDFName, StandardFonts, rgb } from "pdf-lib";
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
    await expect(renderPdfPages(await makePdf(61))).rejects.toBeInstanceOf(
      PdfRenderingError
    );
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
    const error = await renderPdfPages(Buffer.from(await pdf.save())).then(
      () => null,
      (error: unknown) => error
    );
    expect(error).toBeInstanceOf(PdfRenderingError);
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
      ).rejects.toBeInstanceOf(PdfRenderingError);
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
    ).rejects.toBeInstanceOf(PdfRenderingError);
  });

  it("rejects aggregate declared image pixels before decoding unused streams", async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage([100, 100]);
    for (let i = 0; i < 9; i++) declaredImage(pdf, 2000, 2000);
    await expect(
      renderPdfPages(Buffer.from(await pdf.save()))
    ).rejects.toBeInstanceOf(PdfRenderingError);
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
    ).rejects.toBeInstanceOf(PdfRenderingError);
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
    await expect(
      renderPdfPages(Buffer.from("%PDF-secret-document-text-not-a-real-pdf"))
    ).rejects.toThrow(
      "This PDF could not be rendered within the supported limits."
    );
  }, 15_000);
});

describe("renderer process boundaries", () => {
  it("rejects invalid and oversized inputs before spawning", async () => {
    const spawn = vi.mocked(childProcess.spawn);
    await expect(
      renderPdfPages(Buffer.from("not a PDF"))
    ).rejects.toBeInstanceOf(PdfRenderingError);
    await expect(
      renderPdfPages(Buffer.alloc(4 * 1024 * 1024 + 1))
    ).rejects.toBeInstanceOf(PdfRenderingError);
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
    child.stdout.emit("data", Buffer.from('{"ok":false}'));
    child.emit("close", 1);
    await expect(pending).rejects.toBeInstanceOf(PdfRenderingError);
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
    child.emit("close", null);
    expect(await pending).toBeInstanceOf(PdfRenderingError);
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
    await expect(pending).rejects.toBeInstanceOf(PdfRenderingError);
  });

  it("caps stdout even when a child emits unlimited data", async () => {
    const child = fakeChild();
    const pending = renderPdfPages(Buffer.from("%PDF-test"));
    const chunk = Buffer.alloc(1024 * 1024);
    for (let n = 0; n < 40; n++) child.stdout.emit("data", chunk);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    child.emit("close", 1);
    await expect(pending).rejects.toBeInstanceOf(PdfRenderingError);
  });

  it("rejects malformed child output without retaining its text", async () => {
    const child = fakeChild();
    const pending = renderPdfPages(Buffer.from("%PDF-test"));
    child.stdout.emit("data", Buffer.from("private source text; invalid JSON"));
    child.emit("close", 0);
    await expect(pending).rejects.toThrow(
      "This PDF could not be rendered within the supported limits."
    );
  });
});
