// @vitest-environment jsdom

import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UploadedDocument } from "@/lib/types/document";

vi.mock("@/lib/actions/documents", () => ({
  deleteDocument: vi.fn().mockResolvedValue(undefined),
  getDocumentHtml: vi.fn().mockResolvedValue("<h2>Saved result</h2>"),
  getDocumentOutputDownload: vi.fn().mockResolvedValue({
    url: "https://storage.example.test/result.pptx",
    filename: "updated.pptx",
  }),
}));

vi.mock("@/lib/actions/powerpoint-review", () => ({
  getPowerPointReview: vi.fn().mockResolvedValue(null),
  getPowerPointReviewPreview: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/document-upload-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/document-upload-client")>()),
  uploadPowerPointDocument: vi.fn(),
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
import {
  deleteDocument,
  getDocumentHtml,
  getDocumentOutputDownload,
} from "@/lib/actions/documents";
import {
  DocumentUploadError,
  uploadPowerPointDocument,
} from "@/lib/document-upload-client";
import { getPowerPointReview } from "@/lib/actions/powerpoint-review";

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

async function selectOutput(value: "canvas_html" | "accessible_pptx") {
  const select = host.querySelector("select")!;
  expect(host.querySelector(`label[for="${select.id}"]`)?.textContent).toBe(
    "Output format"
  );
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
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
  vi.mocked(deleteDocument).mockResolvedValue(undefined);
  vi.mocked(uploadPowerPointDocument)
    .mockReset()
    .mockImplementation(async ({ file, onReserved }) => {
      const id = `uploaded-${file.name}`;
      onReserved(id);
      return id;
    });
  vi.mocked(getPowerPointReview).mockResolvedValue(null);
  vi.mocked(getDocumentHtml).mockResolvedValue("<h2>Saved result</h2>");
  vi.mocked(getDocumentOutputDownload).mockResolvedValue({
    url: "https://storage.example.test/result.pptx",
    filename: "updated.pptx",
  });
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
  vi.restoreAllMocks();
});

describe("DocumentWorkspace conversion selection", () => {
  it("shows Uploading then Processing and retries a completed PowerPoint upload without sending its file again", async () => {
    let finishUpload!: (documentId: string) => void;
    vi.mocked(uploadPowerPointDocument).mockImplementationOnce(
      ({ onReserved }) => {
        onReserved("ready-source");
        return new Promise((resolve) => {
          finishUpload = resolve;
        });
      }
    );
    const conversion = deferredResponse();
    fetchMock.mockReturnValueOnce(conversion.promise);
    await mount();
    await selectOutput("accessible_pptx");
    await upload("retry.pptx");
    await click(button("Convert"));
    expect(row("retry.pptx").textContent).toContain("Uploading");
    expect(fetchMock).not.toHaveBeenCalled();
    await act(async () => finishUpload("ready-source"));
    expect(row("retry.pptx").textContent).toContain("Processing");
    expect(requests()[0].get("documentId")).toBe("ready-source");
    expect(requests()[0].has("file")).toBe(false);
    await act(async () =>
      conversion.resolve({
        ok: false,
        json: async () => ({ error: "Conversion failed." }),
      } as Response)
    );
    await click(button("Convert"));
    expect(vi.mocked(uploadPowerPointDocument)).toHaveBeenCalledOnce();
    expect(requests().map((form) => form.get("documentId"))).toEqual([
      "ready-source",
      "ready-source",
    ]);
    expect(deleteDocument).not.toHaveBeenCalled();
  });

  it("deletes an incomplete upload reservation and retries with a fresh reservation", async () => {
    vi.mocked(uploadPowerPointDocument).mockImplementationOnce(
      async ({ onReserved }) => {
        onReserved("failed-upload");
        throw new DocumentUploadError();
      }
    );
    await mount();
    await selectOutput("accessible_pptx");
    await upload("retry.pptx");
    await click(button("Convert"));
    expect(deleteDocument).toHaveBeenCalledExactlyOnceWith("failed-upload");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(row("retry.pptx").textContent).toContain("Error");
    await click(button("Convert"));
    expect(uploadPowerPointDocument).toHaveBeenCalledTimes(2);
    expect(requests()[0].get("documentId")).toBe("uploaded-retry.pptx");
    expect(row("retry.pptx").textContent).toContain("Ready to review");
  });

  it("cleans a reservation arriving after its row was deleted and does not resurrect the row", async () => {
    let finishReservation!: () => void;
    vi.mocked(uploadPowerPointDocument).mockImplementationOnce(
      ({ onReserved, signal }) =>
        new Promise((_resolve, reject) => {
          finishReservation = () => {
            onReserved("late-reservation");
            expect(signal.aborted).toBe(true);
            reject(new DOMException("Aborted", "AbortError"));
          };
        })
    );
    await mount();
    await selectOutput("accessible_pptx");
    await upload("removed.pptx");
    await click(button("Convert"));
    await click(button("Remove removed.pptx"));
    await act(async () => finishReservation());
    expect(deleteDocument).toHaveBeenCalledExactlyOnceWith("late-reservation");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(host.querySelectorAll("tbody tr")).toHaveLength(0);
  });

  it("aborts a pending storage upload on deletion and cleans its known reservation only once", async () => {
    let uploadSignal!: AbortSignal;
    vi.mocked(uploadPowerPointDocument).mockImplementationOnce(
      ({ onReserved, signal }) => {
        uploadSignal = signal;
        onReserved("pending-storage");
        return new Promise((_resolve, reject) =>
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true }
          )
        );
      }
    );
    await mount();
    await selectOutput("accessible_pptx");
    await upload("removed.pptx");
    await click(button("Convert"));
    await click(button("Remove removed.pptx"));
    expect(uploadSignal.aborted).toBe(true);
    expect(deleteDocument).toHaveBeenCalledExactlyOnceWith("pending-storage");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(host.querySelectorAll("tbody tr")).toHaveLength(0);
  });

  it("processes a batch sequentially and skips a queued row deleted before its turn", async () => {
    const first = deferredResponse();
    const third = deferredResponse();
    fetchMock
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(third.promise);
    await mount([
      savedDocument("first", "idle"),
      savedDocument("second", "idle"),
      savedDocument("third", "idle"),
    ]);
    await click(button("Convert"));
    expect(requests()).toHaveLength(1);
    expect(row("first.pdf").textContent).toContain("Processing");
    expect(row("second.pdf").textContent).toContain("Queued");
    await click(button("Remove second.pdf"));
    await act(async () => first.resolve(conversionResponse("first")));
    expect(requests().map((form) => form.get("documentId"))).toEqual([
      "first",
      "third",
    ]);
    await act(async () => third.resolve(conversionResponse("third")));
    expect(row("third.pdf").textContent).toContain("Success");
    expect(deleteDocument).toHaveBeenCalledWith("second");
  });

  it("retains a completed upload on navigation and never starts the next queued file", async () => {
    const pending = deferredResponse();
    fetchMock.mockReturnValueOnce(pending.promise);
    await mount();
    await selectOutput("accessible_pptx");
    await upload("first.pptx");
    await upload("second.pptx");
    await click(button("Convert"));
    expect(requests()[0].get("documentId")).toBe("uploaded-first.pptx");
    const signal = fetchMock.mock.calls[0][1]?.signal;
    await act(async () => root.render(null));
    expect(signal?.aborted).toBe(true);
    await act(async () =>
      pending.resolve(conversionResponse("uploaded-first.pptx"))
    );
    expect(uploadPowerPointDocument).toHaveBeenCalledOnce();
    expect(requests()).toHaveLength(1);
    expect(deleteDocument).not.toHaveBeenCalled();
  });

  it("keeps a successful upload whose acknowledgement arrives after navigation", async () => {
    let finishUpload!: (documentId: string) => void;
    vi.mocked(uploadPowerPointDocument).mockImplementationOnce(
      ({ onReserved }) => {
        onReserved("completed-late");
        return new Promise((resolve) => {
          finishUpload = resolve;
        });
      }
    );
    await mount();
    await selectOutput("accessible_pptx");
    await upload("late.pptx");
    await click(button("Convert"));
    await act(async () => root.render(null));
    await act(async () => finishUpload("completed-late"));
    expect(deleteDocument).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("updates the saved row and reopened result with findings for the chosen PowerPoint version", async () => {
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    vi.mocked(getPowerPointReview).mockResolvedValue({
      revisionToken: "a".repeat(64),
      changes: [
        {
          id: "title",
          type: "title",
          slideNumber: 1,
          label: "Identify title",
          before: "No title identified",
          after: "Course introduction",
          reason: "Students can find the slide by its title.",
          operationIds: ["title"],
        },
      ],
      findings: [],
      includedChangeIds: ["title"],
      reviewedChangeIds: [],
      descriptionEdits: {},
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        url: "https://storage.example.test/selected.pptx",
        filename: "selected.pptx",
        revisionToken: "b".repeat(64),
        changes: [],
        findings: [
          {
            type: "other",
            severity: "error",
            title: "Identify this slide's title",
            message:
              "Restoring this change leaves the slide without an identified title.",
            suggestion:
              "Keep the title change or identify a title in PowerPoint.",
          },
        ],
      }),
    } as Response);
    await mount([
      savedDocument("lecture", "success", {
        name: "lecture.pptx",
        outputTarget: "accessible_pptx",
        jobId: "job-1",
      }),
    ]);
    await click(button("lecture.pptx"));
    await click(button("Review changes", document.body));
    await click(button("Restore original", document.body));
    await click(button("Check and download PowerPoint", document.body));
    expect(row("lecture.pptx").textContent).toContain("Needs a fix");
    expect(document.body.textContent).toContain(
      "Restoring this change leaves the slide without an identified title."
    );
    await click(button("Close", document.body));
    await click(button("lecture.pptx"));
    expect(document.body.textContent).toContain(
      "Restoring this change leaves the slide without an identified title."
    );
    expect(button("Download PowerPoint", document.body)).toBeDefined();
    expect(getPowerPointReview).toHaveBeenCalledOnce();
  });
  it("keeps each upload's output format when the selector changes and skips completed PowerPoints", async () => {
    await mount([
      savedDocument("done", "success", {
        name: "done.pptx",
        outputTarget: "accessible_pptx",
      }),
    ]);
    await upload("article.pdf");
    await selectOutput("accessible_pptx");
    await upload("slides.pptx");
    await selectOutput("canvas_html");
    expect(row("article.pdf").textContent).toContain("Canvas HTML");
    expect(row("slides.pptx").textContent).toContain("PowerPoint (.pptx)");
    expect(row("done.pptx").textContent).toContain("Ready to review");
    await click(button("Convert"));
    expect(
      requests().map((form) => [
        (form.get("file") as File)?.name ?? form.get("documentId"),
        form.get("outputTarget"),
      ])
    ).toEqual([
      ["article.pdf", "canvas_html"],
      ["uploaded-slides.pptx", "accessible_pptx"],
    ]);
    expect(requests()[1].has("file")).toBe(false);
    expect(button("Convert").disabled).toBe(true);
    await click(button("Re-convert", row("done.pptx")));
    expect(requests()[2].get("outputTarget")).toBe("accessible_pptx");
    expect(requests()[2].get("documentId")).toBe("done");
  });

  it("does not accept a file belonging to the other selected output format", async () => {
    await mount();
    await upload("slides.pptx");
    expect(host.querySelectorAll("tbody tr")).toHaveLength(0);
    await selectOutput("accessible_pptx");
    await upload("article.pdf");
    expect(host.querySelectorAll("tbody tr")).toHaveLength(0);
    expect(button("Convert").disabled).toBe(true);
  });

  it("shows PowerPoint changes and slide locations, downloads a fresh signed result, and never fetches HTML", async () => {
    const downloadClick = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});
    await mount([
      savedDocument("slides", "success", {
        name: "lecture.pptx",
        outputTarget: "accessible_pptx",
        changes: ["Slide 2: identified the existing title."],
        errors: [
          {
            type: "other",
            severity: "warning",
            title: "Check the reading order",
            message: "Check that the objects are read in a useful order.",
            suggestion: "Open the Reading Order pane in PowerPoint.",
            location: {
              scope: "element",
              sourcePages: [2],
              printedPageLabel: null,
              section: null,
              locator: "Diagram",
              quote: null,
            },
          },
        ],
      }),
    ]);
    await click(button("lecture.pptx"));
    const dialog = document.body.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("Slide 2");
    expect(dialog.textContent).toContain("identified the existing title");
    expect(dialog.textContent).toContain("Accessibility Checker");
    expect(dialog.textContent).not.toContain("PDF page");
    expect(dialog.textContent).not.toContain("Copy HTML");
    expect(dialog.textContent).not.toContain("View HTML output");
    expect(dialog.textContent).not.toContain("online HTML copy is unavailable");
    expect(getDocumentHtml).not.toHaveBeenCalled();
    await click(button("Download PowerPoint", dialog));
    await click(button("Download PowerPoint", dialog));
    expect(getDocumentOutputDownload).toHaveBeenCalledTimes(2);
    expect(getDocumentOutputDownload).toHaveBeenLastCalledWith(
      "slides",
      "accessible_pptx"
    );
    expect(downloadClick).toHaveBeenCalledTimes(2);
  });

  it("explains an expired PowerPoint download without offering HTML actions", async () => {
    vi.mocked(getDocumentOutputDownload).mockResolvedValueOnce(null);
    await mount([
      savedDocument("expired", "success", {
        name: "expired.pptx",
        outputTarget: "accessible_pptx",
      }),
    ]);
    await click(button("expired.pptx"));
    const dialog = document.body.querySelector('[role="dialog"]')!;
    await click(button("Download PowerPoint", dialog));
    expect(dialog.querySelector('[role="alert"]')?.textContent).toContain(
      "expire after 14 days"
    );
    expect(dialog.textContent).not.toContain("Copy HTML");
    expect(getDocumentHtml).not.toHaveBeenCalled();
  });

  it("opens a newly completed PowerPoint response without an HTML field", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        documentId: "saved-slides",
        jobId: "pptx-job",
        outputTarget: "accessible_pptx",
        changes: ["Slide 1: added a title for navigation."],
        errors: [],
        model: "deterministic",
        tokensUsed: 0,
      }),
    } as Response);
    await mount();
    await selectOutput("accessible_pptx");
    await upload("new-slides.pptx");
    await click(button("Convert"));
    expect(row("new-slides.pptx").textContent).toContain("Ready to review");
    await click(button("new-slides.pptx"));
    const dialog = document.body.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain(
      "Slide 1: added a title for navigation."
    );
    expect(button("Download PowerPoint", dialog).disabled).toBe(false);
    expect(dialog.textContent).not.toContain("HTML");
    expect(getDocumentHtml).not.toHaveBeenCalled();
  });

  it("uses the document output format for location labels even if finding metadata claims slides", async () => {
    await mount([
      savedDocument("article", "success", {
        errors: [
          {
            type: "other",
            severity: "warning",
            title: "Check this section",
            message: "Check this section.",
            suggestion: "Compare it to the original.",
            location: {
              scope: "element",
              sourceKind: "slide",
              sourcePages: [3],
              printedPageLabel: null,
              section: null,
              locator: null,
              quote: null,
            },
          },
        ],
      }),
    ]);
    await click(button("article.pdf"));
    const dialog = document.body.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("PDF page 3");
    expect(dialog.textContent).not.toContain("Slide 3");
    expect(getDocumentHtml).toHaveBeenCalledWith("article");
  });

  it("marks completed PowerPoints with accessibility errors as needing a fix while keeping downloads and batch skipping", async () => {
    const issue = {
      type: "no-table-headers" as const,
      severity: "error" as const,
      title: "Identify the table labels",
      message:
        "The table is missing column labels for software that reads aloud.",
      suggestion: "Select the table in PowerPoint and identify its header row.",
    };
    await mount([
      savedDocument("needs-fix", "success", {
        name: "needs-fix.pptx",
        outputTarget: "accessible_pptx",
        errors: [issue],
      }),
      savedDocument("review-only", "success", {
        name: "review-only.pptx",
        outputTarget: "accessible_pptx",
        errors: [{ ...issue, severity: "warning" }],
      }),
    ]);
    expect(
      row("needs-fix.pptx").cells[3].querySelector('[data-slot="badge"]')
        ?.textContent
    ).toBe("Needs a fix");
    expect(row("needs-fix.pptx").textContent).not.toContain("Ready to review");
    expect(row("review-only.pptx").textContent).toContain("Ready to review");
    expect(button("Convert").disabled).toBe(true);
    await click(button("needs-fix.pptx"));
    const dialog = document.body.querySelector('[role="dialog"]')!;
    expect(dialog.querySelector('[role="status"]')?.textContent).toContain(
      "still has accessibility problems that need a fix"
    );
    expect(button("Download PowerPoint", dialog).disabled).toBe(false);
    await click(button("Close", document.body));
    await upload("new.pdf");
    await click(button("Convert"));
    expect(requests()).toHaveLength(1);
    expect((requests()[0].get("file") as File).name).toBe("new.pdf");
  });

  it("distinguishes completed conversions needing review from failed conversions", async () => {
    await mount([
      savedDocument("needs-review", "success", {
        errors: [
          {
            type: "missing-alt",
            severity: "error",
            message: "The image needs a description.",
            suggestion: "Describe the image in Canvas.",
          },
          {
            type: "heading-skip",
            severity: "warning",
            message: "Check this section heading.",
            suggestion: "Check its relationship to the previous section.",
          },
        ],
      }),
      savedDocument("failed", "error", {
        errorMessage: "Conversion did not complete.",
      }),
    ]);
    expect(row("needs-review.pdf").textContent).toContain("Success");
    expect(row("needs-review.pdf").textContent).toContain("Needs a fix: 1");
    expect(row("needs-review.pdf").textContent).toContain("Please check: 1");
    expect(row("failed.pdf").textContent).toContain("Error");
    expect(row("failed.pdf").textContent).not.toContain("Needs a fix");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("converts a newly added document without re-sending the first successful document", async () => {
    await mount();
    expect(button("Convert").disabled).toBe(true);

    await upload("first.pdf");
    await click(button("Convert"));
    expect(row("first.pdf").textContent).toContain("Success");
    expect(row("first.pdf").textContent).toContain("Please check: 1");
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
        detail:
          "PDF page preparation stopped on PDF page 5. An image exceeds the processing limit.",
      }),
    } as Response);
    await mount();
    await upload("retry.pdf");
    await click(button("Convert"));
    expect(row("retry.pdf").textContent).toContain("Error");
    await click(button("retry.pdf"));
    expect(
      document.body.querySelector('[role="dialog"]')?.textContent
    ).toContain("PDF page 5");
    await click(button("Close", document.body));
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
