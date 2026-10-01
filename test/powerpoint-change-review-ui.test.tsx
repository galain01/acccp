// @vitest-environment jsdom

import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PowerPointReviewData } from "@/lib/powerpoint-review-contract";
import type { UploadedDocument } from "@/lib/types/document";

vi.mock("@/lib/actions/powerpoint-review", () => ({
  getPowerPointReview: vi.fn(),
  getPowerPointReviewPreview: vi.fn().mockResolvedValue(null),
}));
vi.mock("next/image", () => ({
  default: (
    props: React.ImgHTMLAttributes<HTMLImageElement> & { unoptimized?: boolean }
  ) => {
    const imageProps = { ...props };
    delete imageProps.unoptimized;
    return React.createElement("img", imageProps);
  },
}));
vi.mock("@/lib/actions/documents", () => ({
  getDocumentHtml: vi.fn(),
  getDocumentOutputDownload: vi.fn(),
}));

import {
  getPowerPointReview,
  getPowerPointReviewPreview,
} from "@/lib/actions/powerpoint-review";
import PowerPointChangeReview from "@/components/ui/powerpoint-change-review";
import ConversionResultDialog from "@/components/ui/conversion-result-dialog";

let host: HTMLDivElement;
let root: Root;
const fetchMock = vi.fn<typeof fetch>();
const onExportComplete = vi.fn();

function fixture(): PowerPointReviewData {
  return {
    revisionToken: "a".repeat(64),
    changes: [
      {
        id: "language",
        type: "language",
        slideNumber: 3,
        label: "French pronunciation",
        before: "English",
        after: "French",
        reason: "This sentence is written in French.",
        operationIds: ["language-1"],
      },
      {
        id: "order",
        type: "reading-order",
        slideNumber: 3,
        label: "Title before objectives",
        before: "Objectives, then title",
        after: "Title, then objectives",
        reason: "Students hear the topic before its details.",
        assumption: "Is this the order students should hear?",
        operationIds: ["order-1", "order-2"],
      },
      {
        id: "description",
        type: "description",
        slideNumber: 5,
        label: "Grading diagram description",
        before: "Grading rubric",
        after: "Homework: 15%. Exams: 50%. Projects: 35%.",
        reason: "The description includes the grading weights.",
        assumption: "Are these the grading categories you intend?",
        operationIds: ["description-1"],
        editableDescription: true,
      },
    ],
    findings: [],
    includedChangeIds: ["language", "order", "description"],
    reviewedChangeIds: [],
    descriptionEdits: {},
  };
}

function button(label: string, scope: ParentNode = host) {
  const found = Array.from(scope.querySelectorAll("button")).find(
    (item) => item.textContent?.trim() === label
  );
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}

async function click(element: HTMLElement) {
  await act(async () => element.click());
}

async function mount(data = fixture()) {
  vi.mocked(getPowerPointReview).mockResolvedValue(data);
  await act(async () =>
    root.render(
      <PowerPointChangeReview
        documentId="doc-1"
        jobId="job-1"
        onExportComplete={onExportComplete}
      />
    )
  );
}

function lastSelection() {
  return JSON.parse(String(fetchMock.mock.calls.at(-1)?.[1]?.body));
}

beforeEach(() => {
  vi.mocked(getPowerPointReviewPreview).mockReset().mockResolvedValue(null);
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({
      url: "https://storage.example.test/selected.pptx",
      revisionToken: "b".repeat(64),
      filename: "selected.pptx",
      findings: [],
      changes: ["French pronunciation"],
    }),
  } as Response);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("PowerPoint revision choices", () => {
  it("loads only the expanded slide preview and reuses it when returning to that slide", async () => {
    const data = fixture();
    data.previewSlideNumbers = [3, 5];
    vi.mocked(getPowerPointReviewPreview).mockResolvedValue({
      slideNumber: 3,
      before: "data:image/png;base64,original",
      after: "data:image/png;base64,updated",
    });
    await mount(data);
    expect(getPowerPointReviewPreview).not.toHaveBeenCalled();
    const disclosure = host.querySelector("article details")!;
    await act(async () => {
      (disclosure as HTMLDetailsElement).open = true;
      disclosure.dispatchEvent(new Event("toggle"));
    });
    expect(getPowerPointReviewPreview).toHaveBeenCalledExactlyOnceWith(
      "doc-1",
      "job-1",
      "a".repeat(64),
      3
    );
    expect(host.querySelectorAll("article img")).toHaveLength(2);
    expect(host.textContent).toContain(
      "They do not update as you change your choices"
    );
    await act(async () => {
      (disclosure as HTMLDetailsElement).open = false;
      disclosure.dispatchEvent(new Event("toggle"));
      (disclosure as HTMLDetailsElement).open = true;
      disclosure.dispatchEvent(new Event("toggle"));
    });
    expect(getPowerPointReviewPreview).toHaveBeenCalledOnce();
  });

  it("keeps review controls available after a failed preview and allows a safe retry", async () => {
    const data = fixture();
    data.previewSlideNumbers = [3];
    vi.mocked(getPowerPointReviewPreview).mockRejectedValueOnce(
      new Error("private storage error")
    );
    await mount(data);
    await act(async () => {
      const disclosure = host.querySelector(
        "article details"
      ) as HTMLDetailsElement;
      disclosure.open = true;
      disclosure.dispatchEvent(new Event("toggle"));
    });
    expect(host.textContent).toContain(
      "This slide preview could not be loaded"
    );
    expect(host.textContent).not.toContain("private storage error");
    expect(button("Keep change").disabled).toBe(false);
    expect(button("Restore original").disabled).toBe(false);
    await click(button("Restore original"));
    await click(button("Try preview again"));
    expect(getPowerPointReviewPreview).toHaveBeenCalledTimes(2);
    expect(host.textContent).toContain("This slide preview is unavailable");
    expect(button("Check and download chosen version").disabled).toBe(false);
  });
  it("starts with assumptions, distinguishes included from reviewed and keeps routine repairs collapsed", async () => {
    await mount();
    expect(host.querySelector("article")?.textContent).toContain(
      "Is this the order students should hear?"
    );
    expect(host.textContent).toContain(
      "3 of 3 changes included · 0 reviewed · 2 assumptions to review"
    );
    expect(host.querySelector("nav details")?.hasAttribute("open")).toBe(false);
    expect(host.querySelector("article")?.textContent).toContain(
      "related edits work together"
    );
  });

  it("restores an atomic change while preserving independent routine fixes and sends actual choices for recheck", async () => {
    await mount();
    await click(button("Restore original"));
    expect(host.textContent).toContain("2 of 3 changes included · 1 reviewed");
    expect(host.querySelector("article")?.textContent).toContain(
      "Original restored"
    );
    expect(host.querySelector("article")?.textContent).toContain(
      "may bring back a problem"
    );
    await click(button("Check and download chosen version"));
    expect(lastSelection()).toMatchObject({
      documentId: "doc-1",
      jobId: "job-1",
      includedChangeIds: ["language", "description"],
      reviewedChangeIds: ["order"],
      descriptionEdits: {},
    });
    expect(onExportComplete).toHaveBeenCalledOnce();
    expect(host.textContent).toContain("checked and saved");
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledOnce();
  });

  it("lets faculty keep a previously restored change without reviewing unrelated changes", async () => {
    await mount();
    await click(button("Restore original"));
    await click(button("Keep change"));
    await click(button("Check and download chosen version"));
    expect(lastSelection().includedChangeIds).toEqual([
      "language",
      "order",
      "description",
    ]);
    expect(lastSelection().reviewedChangeIds).toEqual(["order"]);
  });

  it("edits descriptions, blocks accidental export of unsaved wording, and does not send excluded wording", async () => {
    await mount();
    const descriptionButton = Array.from(
      host.querySelectorAll("nav button")
    ).find((item) =>
      item.textContent?.includes("Grading diagram description")
    )!;
    await click(descriptionButton as HTMLElement);
    await click(button("Edit wording"));
    expect(button("Check and download chosen version").disabled).toBe(true);
    const textarea = host.querySelector("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value"
      )!.set!.call(textarea, "Homework counts for 15 percent of the grade.");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(button("Use this wording"));
    await click(button("Check and download chosen version"));
    expect(lastSelection().descriptionEdits).toEqual({
      description: "Homework counts for 15 percent of the grade.",
    });
    await click(button("Restore original"));
    await click(button("Check and download chosen version"));
    expect(lastSelection().descriptionEdits).toEqual({});
    expect(lastSelection().revisionToken).toBe("b".repeat(64));
  });

  it("loads saved choices separately from the all-repairs proposal", async () => {
    const data = fixture();
    data.includedChangeIds = ["language"];
    data.reviewedChangeIds = ["order", "description"];
    await mount(data);
    expect(host.textContent).toContain("1 of 3 changes included · 2 reviewed");
    expect(host.querySelector("article")?.textContent).toContain(
      "Proposed change · excluded"
    );
  });

  it("prevents duplicate exports and reports fresh issues from the chosen output", async () => {
    let resolve!: (value: Response) => void;
    fetchMock.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      })
    );
    await mount();
    const exportButton = button("Check and download chosen version");
    await act(async () => {
      exportButton.click();
      exportButton.click();
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(button("Keep change").disabled).toBe(true);
    await act(async () =>
      resolve({
        ok: true,
        json: async () => ({
          url: "https://storage.example.test/selected.pptx",
          revisionToken: "b".repeat(64),
          filename: "selected.pptx",
          findings: [
            {
              type: "other",
              severity: "warning",
              message: "Restored title order needs attention.",
              suggestion: "Put the title first.",
            },
          ],
          changes: [],
        }),
      } as Response)
    );
    expect(host.textContent).toContain("1 item still needs attention");
    expect(onExportComplete.mock.calls[0][0].findings[0].message).toContain(
      "Restored title order"
    );
  });

  it("keeps choices after failed export and hides raw server errors", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({ error: "sensitive provider body" }),
    } as Response);
    await mount();
    await click(button("Restore original"));
    await click(button("Check and download chosen version"));
    expect(host.textContent).toContain("Your choices are still here");
    expect(host.textContent).not.toContain("sensitive provider body");
    expect(host.textContent).toContain("2 of 3 changes included");
    expect(onExportComplete).not.toHaveBeenCalled();
  });

  it("shows a safe missing-history explanation and never fetches history until requested", async () => {
    vi.mocked(getPowerPointReview).mockResolvedValue(null);
    const file: UploadedDocument = {
      id: "doc-1",
      documentId: "doc-1",
      jobId: "job-1",
      name: "Lecture.pptx",
      size: 100,
      uploadedAt: new Date(),
      status: "success",
      locked: false,
      outputTarget: "accessible_pptx",
    };
    await act(async () =>
      root.render(
        <ConversionResultDialog document={file} open onOpenChange={() => {}} />
      )
    );
    expect(getPowerPointReview).not.toHaveBeenCalled();
    await click(button("Review changes", document.body));
    expect(getPowerPointReview).toHaveBeenCalledWith("doc-1", "job-1");
    expect(document.body.textContent).toContain(
      "change history is unavailable"
    );
    expect(document.body.textContent).toContain("14 days");
  });

  it("replaces the original findings after successful chosen-version export", async () => {
    vi.mocked(getPowerPointReview).mockResolvedValue(fixture());
    const file: UploadedDocument = {
      id: "doc-1",
      documentId: "doc-1",
      jobId: "job-1",
      name: "Lecture.pptx",
      size: 100,
      uploadedAt: new Date(),
      status: "success",
      locked: false,
      outputTarget: "accessible_pptx",
      errors: [
        {
          type: "other",
          title: "Check the slide order",
          severity: "error",
          message: "The original output has an unresolved problem.",
          suggestion: "Check the original problem.",
        },
      ],
    };
    await act(async () =>
      root.render(
        <ConversionResultDialog
          document={file}
          open
          onOpenChange={() => {}}
          onReviewExport={onExportComplete}
        />
      )
    );
    expect(document.body.textContent).toContain(
      "The original output has an unresolved problem."
    );
    await click(button("Review changes", document.body));
    await click(button("Check and download chosen version", document.body));
    expect(document.body.textContent).not.toContain(
      "The original output has an unresolved problem."
    );
    expect(onExportComplete).toHaveBeenCalledOnce();
  });
});
