// @vitest-environment jsdom

import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import FileUpload from "@/components/ui/file-upload";
import {
  MAX_FILE_SIZE_BYTES,
  MAX_PPTX_FILE_SIZE_BYTES,
} from "@/lib/document-input";

let host: HTMLDivElement;
let root: Root;
const onFilesSelected = vi.fn();

beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function choose(files: File[]) {
  const input = host.querySelector('input[type="file"]')!;
  await act(async () => {
    Object.defineProperty(input, "files", { value: files, configurable: true });
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

describe("output-specific file selection", () => {
  it("accepts only nonempty supported PowerPoints within the size limit", async () => {
    await act(async () =>
      root.render(
        <FileUpload
          outputTarget="accessible_pptx"
          onFilesSelected={onFilesSelected}
        />
      )
    );
    const valid = new File(["synthetic"], "lecture.PPTX");
    const largeValid = new File(
      [new Uint8Array(MAX_PPTX_FILE_SIZE_BYTES)],
      "large-valid.pptx"
    );
    await choose([
      valid,
      largeValid,
      new File(["synthetic"], "old.ppt"),
      new File(["synthetic"], "macro.pptm"),
      new File(["synthetic"], "article.pdf"),
      new File([], "empty.pptx"),
      new File(
        [new Uint8Array(MAX_PPTX_FILE_SIZE_BYTES + 1)],
        "too-large.pptx"
      ),
    ]);
    expect(onFilesSelected).toHaveBeenCalledExactlyOnceWith([
      valid,
      largeValid,
    ]);
    expect(host.textContent).toContain("25 MB");
    expect(host.querySelector("input")?.accept).toContain(".pptx");
    expect(host.querySelector("input")?.accept).not.toContain(".pdf");
    expect(host.querySelector('[role="status"]')?.textContent).toContain(
      "PowerPoint (.pptx)"
    );
    expect(host.textContent).toContain("Accessibility Checker");
    expect(host.textContent).not.toContain("Preparing PDF pages");
  });

  it("keeps Word and PDF input available for the default Canvas output", async () => {
    await act(async () =>
      root.render(<FileUpload onFilesSelected={onFilesSelected} />)
    );
    const pdf = new File(["synthetic"], "article.pdf");
    const word = new File(["synthetic"], "notes.docx");
    await choose([
      pdf,
      word,
      new File(["synthetic"], "slides.pptx"),
      new File([new Uint8Array(MAX_FILE_SIZE_BYTES + 1)], "large.pdf"),
      new File([new Uint8Array(MAX_FILE_SIZE_BYTES + 1)], "large.docx"),
    ]);
    expect(onFilesSelected).toHaveBeenCalledExactlyOnceWith([pdf, word]);
    expect(host.querySelector("input")?.accept).toContain(".pdf,.docx");
    expect(host.querySelector('[role="status"]')?.textContent).toContain(
      "PDF or Word"
    );
    expect(host.textContent).toContain("90-second limit");
  });
});
