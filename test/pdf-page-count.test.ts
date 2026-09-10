import { describe, expect, it, vi } from "vitest";
import { PDFDocument } from "pdf-lib";

vi.mock("server-only", () => ({}));

import { countPdfPages } from "@/lib/pdf-page-count";

describe("PDF page counting in the real isolated worker", () => {
  it.each([1, 8])(
    "counts %i pages in PDFs using compressed object streams",
    async (pages) => {
      const pdf = await PDFDocument.create();
      for (let index = 0; index < pages; index++) pdf.addPage();
      const bytes = Buffer.from(await pdf.save({ useObjectStreams: true }));
      expect(await countPdfPages(bytes)).toBe(pages);
    }
  );

  it("treats malformed PDFs as unknown without exposing parser errors", async () => {
    expect(
      await countPdfPages(Buffer.from("%PDF-1.7\nprivate malformed content"))
    ).toBeNull();
  });

  it("does not mutate or detach the original PDF buffer", async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage();
    const bytes = Buffer.from(await pdf.save());
    const original = Buffer.from(bytes);
    expect(await countPdfPages(bytes)).toBe(1);
    expect(bytes.equals(original)).toBe(true);
  });
});
