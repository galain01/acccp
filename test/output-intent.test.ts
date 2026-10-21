import { describe, expect, it } from "vitest";
import {
  getOutputChoice,
  getDocumentOutputChoice,
  isOutputIntent,
} from "@/lib/output-intent";
import { isOutputTarget } from "@/lib/output-formats";

describe("requested document output", () => {
  it.each(["article.pdf"])(
    "never substitutes HTML for unavailable native %s output",
    (filename) => {
      const choice = getOutputChoice(filename, "original");
      expect(choice.target).toBeUndefined();
      expect(choice.unavailableReason).toContain("not available yet");
      // Even a stale resolved destination cannot override the user's current intent.
      expect(
        getDocumentOutputChoice({
          name: filename,
          outputIntent: "original",
          outputTarget: "canvas_html",
        }).target
      ).toBeUndefined();
      expect(getOutputChoice(filename, "html").target).toBe("canvas_html");
    }
  );

  it("offers native Word without changing previously saved HTML destinations", () => {
    expect(getOutputChoice("notes.DOCX", "original").target).toBe(
      "accessible_docx"
    );
    expect(getOutputChoice("notes.docx", "html").target).toBe("canvas_html");
    expect(
      getDocumentOutputChoice({ name: "old.docx", outputTarget: "canvas_html" })
        .target
    ).toBe("canvas_html");
    expect(isOutputTarget("accessible_docx")).toBe(true);
  });

  it("supports native PowerPoint while leaving HTML unavailable", () => {
    expect(getOutputChoice("lecture.PPTX", "original").target).toBe(
      "accessible_pptx"
    );
    expect(getOutputChoice("lecture.PPTX", "html").target).toBeUndefined();
  });

  it("retains the legacy HTML default and explicit saved target", () => {
    expect(getDocumentOutputChoice({ name: "old.docx" }).target).toBe(
      "canvas_html"
    );
    expect(
      getDocumentOutputChoice({
        name: "old.pptx",
        outputTarget: "accessible_pptx",
      }).target
    ).toBe("accessible_pptx");
    expect(getDocumentOutputChoice({ name: "old.doc" }).target).toBeUndefined();
  });

  it("does not widen the API contract to unsupported targets or UI intent values", () => {
    for (const value of ["original", "html", "accessible_pdf"])
      expect(isOutputTarget(value)).toBe(false);
    expect(isOutputIntent("original")).toBe(true);
    expect(isOutputIntent("html")).toBe(true);
    expect(isOutputIntent("accessible_pdf")).toBe(false);
  });
});
