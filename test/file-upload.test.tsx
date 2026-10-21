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

describe("mixed document selection", () => {
  it("accepts mixed formats and their exact size boundaries in one upload", async () => {
    await act(async () =>
      root.render(<FileUpload onFilesSelected={onFilesSelected} />)
    );
    const valid = new File(["synthetic"], "lecture.PPTX");
    const pdf = new File([new Uint8Array(MAX_FILE_SIZE_BYTES)], "article.pdf");
    const word = new File([new Uint8Array(MAX_FILE_SIZE_BYTES)], "notes.DOCX");
    const largeValid = new File(
      [new Uint8Array(MAX_PPTX_FILE_SIZE_BYTES)],
      "large-valid.pptx"
    );
    await choose([
      valid,
      largeValid,
      pdf,
      word,
      new File(["synthetic"], "old.ppt"),
      new File(["synthetic"], "macro.pptm"),
      new File(["synthetic"], "macro.docm"),
      new File([], "empty.pptx"),
      new File(
        [new Uint8Array(MAX_PPTX_FILE_SIZE_BYTES + 1)],
        "too-large.pptx"
      ),
    ]);
    expect(onFilesSelected).toHaveBeenCalledExactlyOnceWith([
      valid,
      largeValid,
      pdf,
      word,
    ]);
    expect(host.textContent).toContain("25 MB");
    expect(host.querySelector("input")?.accept).toContain(".pptx");
    expect(host.querySelector("input")?.accept).toContain(".pdf,.docx,.pptx");
    expect(host.querySelector('[role="status"]')?.textContent).toContain(
      "PowerPoint (.pptx)"
    );
  });

  it("rejects empty and over-limit files without hiding valid mixed uploads", async () => {
    await act(async () =>
      root.render(<FileUpload onFilesSelected={onFilesSelected} />)
    );
    const pdf = new File(["synthetic"], "article.pdf");
    const word = new File(["synthetic"], "notes.docx");
    const slides = new File(["synthetic"], "slides.pptx");
    await choose([
      pdf,
      word,
      slides,
      new File([], "empty.pdf"),
      new File([], "empty.docx"),
      new File([new Uint8Array(MAX_FILE_SIZE_BYTES + 1)], "large.pdf"),
      new File([new Uint8Array(MAX_FILE_SIZE_BYTES + 1)], "large.docx"),
    ]);
    expect(onFilesSelected).toHaveBeenCalledExactlyOnceWith([
      pdf,
      word,
      slides,
    ]);
    expect(host.querySelector("input")?.accept).toContain(".pdf,.docx");
    expect(host.querySelector('[role="status"]')?.textContent).toContain(
      "4 files were not added"
    );
    await choose([pdf]);
    expect(host.querySelector('[role="status"]')).toBeNull();
  });

  it("does not accept a selection while processing is active", async () => {
    await act(async () =>
      root.render(<FileUpload disabled onFilesSelected={onFilesSelected} />)
    );
    await choose([new File(["synthetic"], "slides.pptx")]);
    expect(onFilesSelected).not.toHaveBeenCalled();
    expect(host.querySelector<HTMLInputElement>("input")?.disabled).toBe(true);
  });
});
