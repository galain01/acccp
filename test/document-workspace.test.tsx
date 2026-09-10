// @vitest-environment jsdom

import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UploadedDocument } from "@/lib/types/document";

vi.mock("@/lib/actions/documents", () => ({
  deleteDocument: vi.fn().mockResolvedValue(undefined),
  getDocumentHtml: vi.fn().mockResolvedValue("<h2>Saved result</h2>"),
}));

// Only replace the browser file picker. Selection, status changes, buttons,
// and request construction remain the actual workspace and document table.
vi.mock("@/components/ui/file-upload", () => ({
  default: ({
    onFilesSelected,
    disabled,
  }: {
    onFilesSelected: (files: File[]) => void;
    disabled: boolean;
  }) => (
    <input
      type="file"
      aria-label="Upload documents"
      multiple
      disabled={disabled}
      onChange={(event) =>
        onFilesSelected(Array.from(event.currentTarget.files ?? []))
      }
    />
  ),
}));

import DocumentWorkspace from "@/components/ui/document-workspace";
import { TooltipProvider } from "@/components/ui/tooltip";

const SESSION_ID = "synthetic-session";
let host: HTMLDivElement;
let root: Root;
const fetchMock = vi.fn<typeof fetch>();

function savedDocument(
  id: string,
  status: UploadedDocument["status"],
  patch: Partial<UploadedDocument> = {}
): UploadedDocument {
  return {
    id,
    documentId: id,
    name: `${id}.pdf`,
    size: 100,
    uploadedAt: new Date("2026-09-10T12:00:00Z"),
    status,
    locked: false,
    ...patch,
  };
}

function conversionResponse(documentId: string): Response {
  return {
    ok: true,
    json: async () => ({
      documentId,
      html: `<h2>Converted ${documentId}</h2>`,
      // Audit findings still represent a completed conversion and must not
      // cause the next batch to spend tokens repeating the successful job.
      errors: [
        {
          type: "other",
          severity: "warning",
          message: "Review source formatting.",
        },
      ],
    }),
  } as Response;
}

function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function buttons(scope: ParentNode = host): HTMLButtonElement[] {
  return Array.from(scope.querySelectorAll("button"));
}

function button(label: string, scope: ParentNode = host): HTMLButtonElement {
  const found = buttons(scope).find(
    (candidate) =>
      candidate.textContent?.trim() === label ||
      candidate.getAttribute("aria-label") === label
  );
  expect(found, `Expected button ${label}`).toBeDefined();
  return found!;
}

function isDisabled(target: HTMLButtonElement): boolean {
  return target.disabled || target.getAttribute("aria-disabled") === "true";
}

function row(name: string): HTMLTableRowElement {
  const found = Array.from(host.querySelectorAll("tbody tr")).find(
    (candidate) => candidate.textContent?.includes(name)
  );
  expect(found, `Expected document row ${name}`).toBeDefined();
  return found as HTMLTableRowElement;
}

function uploadInput(): HTMLInputElement {
  return host.querySelector('input[type="file"]')!;
}

async function mount(documents: UploadedDocument[] = []) {
  await act(async () => {
    root.render(
      <TooltipProvider>
        <DocumentWorkspace
          sessionId={SESSION_ID}
          initialDocuments={documents}
        />
      </TooltipProvider>
    );
  });
}

async function upload(name: string) {
  const file = new File(["%PDF-synthetic"], name, {
    type: "application/pdf",
  });
  await act(async () => {
    Object.defineProperty(uploadInput(), "files", {
      value: [file],
      configurable: true,
    });
    uploadInput().dispatchEvent(new Event("change", { bubbles: true }));
  });
  return file;
}

async function click(target: HTMLButtonElement) {
  await act(async () => target.click());
}

function requests(): FormData[] {
  return fetchMock.mock.calls.map(([url, init]) => {
    expect(url).toBe("/api/convert");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBeInstanceOf(FormData);
    const form = init!.body as FormData;
    expect(form.get("sessionId")).toBe(SESSION_ID);
    return form;
  });
}

beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (_url, init) => {
    const form = init!.body as FormData;
    const id = form.get("documentId") ?? (form.get("file") as File).name;
    return conversionResponse(String(id));
  });
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

describe("DocumentWorkspace conversion selection", () => {
  it("converts a newly added document without re-sending the first successful document", async () => {
    await mount();
    expect(button("Convert").disabled).toBe(true);

    await upload("first.pdf");
    await click(button("Convert"));
    expect(row("first.pdf").textContent).toContain("Success");
    expect(row("first.pdf").textContent).toContain("1 warning");
    expect(button("Convert").disabled).toBe(true);

    await upload("second.pdf");
    expect(button("Convert").disabled).toBe(false);
    await click(button("Convert"));

    expect(requests().map((form) => (form.get("file") as File)?.name)).toEqual([
      "first.pdf",
      "second.pdf",
    ]);
    expect(requests().every((form) => !form.has("documentId"))).toBe(true);
    expect(row("first.pdf").textContent).toContain("Success");
    expect(row("second.pdf").textContent).toContain("Success");
    expect(button("Convert").disabled).toBe(true);
  });

  it("skips unlocked successes restored on reload while allowing failed jobs to retry", async () => {
    await mount([
      savedDocument("already-done", "success"),
      savedDocument("retry-me", "error"),
      savedDocument("new-ready", "idle"),
    ]);
    expect(button("Convert").disabled).toBe(false);
    await click(button("Convert"));

    expect(requests().map((form) => form.get("documentId"))).toEqual([
      "retry-me",
      "new-ready",
    ]);
    expect(row("already-done.pdf").textContent).toContain("Success");
    expect(row("retry-me.pdf").textContent).toContain("Success");
    expect(row("new-ready.pdf").textContent).toContain("Success");
    expect(button("Convert").disabled).toBe(true);
  });

  it("re-converts just the selected successful document, leaving a new document ready", async () => {
    await mount([
      savedDocument("selected", "success"),
      savedDocument("other-success", "success"),
    ]);
    await upload("new.pdf");
    await click(button("Re-convert", row("selected.pdf")));

    expect(requests().map((form) => form.get("documentId"))).toEqual([
      "selected",
    ]);
    expect(requests()[0].has("file")).toBe(false);
    expect(row("new.pdf").textContent).toContain("Ready");
    expect(row("other-success.pdf").textContent).toContain("Success");

    await click(button("Convert"));
    expect(requests()).toHaveLength(2);
    expect((requests()[1].get("file") as File).name).toBe("new.pdf");
  });

  it("retries a failed newly uploaded document using the source the server already saved", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      json: async () => ({
        documentId: "saved-before-model-error",
        error: "Conversion failed.",
      }),
    } as Response);
    await mount();
    await upload("retry.pdf");
    await click(button("Convert"));
    expect(row("retry.pdf").textContent).toContain("Error");
    expect(button("Convert").disabled).toBe(false);

    await click(button("Convert"));
    expect(requests()).toHaveLength(2);
    expect((requests()[0].get("file") as File).name).toBe("retry.pdf");
    expect(requests()[1].get("documentId")).toBe("saved-before-model-error");
    expect(requests()[1].has("file")).toBe(false);
    expect(row("retry.pdf").textContent).toContain("Success");
  });

  it("keeps locked and unsupported files out of bulk conversion and re-conversion", async () => {
    await mount([
      savedDocument("locked-ready", "idle", { locked: true }),
      savedDocument("locked-success", "success", { locked: true }),
      savedDocument("legacy-success", "success", { name: "legacy.doc" }),
      savedDocument("legacy-error", "error", { name: "legacy.txt" }),
      savedDocument("ready", "idle", { name: "ready.DOCX" }),
    ]);

    expect(isDisabled(button("Re-convert", row("locked-success.pdf")))).toBe(
      true
    );
    await click(button("Re-convert", row("locked-success.pdf")));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      buttons(row("legacy.doc")).some(
        (item) => item.textContent?.trim() === "Re-convert"
      )
    ).toBe(false);
    await click(button("Convert"));
    expect(requests().map((form) => form.get("documentId"))).toEqual(["ready"]);
    expect(row("locked-ready.pdf").textContent).toContain("Ready");
    expect(row("legacy.txt").textContent).toContain("Error");
    expect(button("Convert").disabled).toBe(true);
  });

  it("blocks repeated clicks and every other conversion while a batch is pending", async () => {
    const pending = deferredResponse();
    fetchMock.mockReturnValueOnce(pending.promise);
    await mount([
      savedDocument("saved-success", "success"),
      savedDocument("ready", "idle"),
    ]);
    const bulk = button("Convert");
    const reconvert = button("Re-convert", row("saved-success.pdf"));

    // Dispatch before React flushes the disabled state: a button-only guard
    // would permit duplicate requests in this same-event-loop race.
    await act(async () => {
      bulk.click();
      bulk.click();
      reconvert.click();
    });

    expect(requests()).toHaveLength(1);
    expect(requests()[0].get("documentId")).toBe("ready");
    expect(button("Convert").disabled).toBe(true);
    expect(isDisabled(button("Re-convert", row("saved-success.pdf")))).toBe(
      true
    );
    expect(uploadInput().disabled).toBe(true);

    await act(async () => pending.resolve(conversionResponse("ready")));
    expect(row("ready.pdf").textContent).toContain("Success");
    expect(isDisabled(button("Re-convert", row("saved-success.pdf")))).toBe(
      false
    );
    expect(uploadInput().disabled).toBe(false);
  });

  it("blocks duplicate single-document re-conversion and a simultaneous bulk request", async () => {
    const pending = deferredResponse();
    fetchMock.mockReturnValueOnce(pending.promise);
    await mount([
      savedDocument("selected", "success"),
      savedDocument("other-success", "success"),
      savedDocument("new-ready", "idle"),
    ]);
    const reconvert = button("Re-convert", row("selected.pdf"));
    const bulk = button("Convert");
    await act(async () => {
      reconvert.click();
      reconvert.click();
      bulk.click();
    });

    expect(requests().map((form) => form.get("documentId"))).toEqual([
      "selected",
    ]);
    expect(isDisabled(button("Re-convert", row("other-success.pdf")))).toBe(
      true
    );
    expect(button("Convert").disabled).toBe(true);
    expect(row("new-ready.pdf").textContent).toContain("Ready");

    await act(async () => pending.resolve(conversionResponse("selected")));
    expect(button("Convert").disabled).toBe(false);
  });

  it.each(["queued", "processing"] as const)(
    "disables conversion for a workspace restored with a %s job",
    async (status) => {
      await mount([
        savedDocument("busy", status),
        savedDocument("saved-success", "success"),
        savedDocument("ready", "idle"),
      ]);
      expect(button("Convert").disabled).toBe(true);
      expect(isDisabled(button("Re-convert", row("saved-success.pdf")))).toBe(
        true
      );
      expect(uploadInput().disabled).toBe(true);
      await click(button("Convert"));
      await click(button("Re-convert", row("saved-success.pdf")));
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );
});
