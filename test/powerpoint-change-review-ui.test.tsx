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
  it("explains a decorative image's reading setting and shows one original context image", async () => {
    const data = fixture();
    data.changes = [
      {
        id: "decorative",
        type: "decorative",
        slideNumber: 2,
        objectId: "image-1",
        label: "Skip a repeated border image",
        before: "Not marked decorative; no description provided.",
        after: "Marked decorative; reading software skips this image.",
        reason:
          "The border repeats a visual motif and adds no teaching information.",
        assumption: "Can students skip this border without losing information?",
        operationIds: ["decorative-1"],
      },
    ];
    data.includedChangeIds = ["decorative"];
    data.previews = [
      {
        slideNumber: 2,
        before: "data:image/png;base64,original",
        after: "data:image/png;base64,repaired",
      },
    ];
    await mount(data);
    const article = host.querySelector("article")!;
    expect(article.textContent).toContain("Original image reading setting");
    expect(article.textContent).toContain("Suggested image reading setting");
    expect(article.textContent).toContain("stays visible");
    expect(article.textContent).toContain(
      "software that reads slides aloud skips it"
    );
    expect(article.textContent).toContain(
      "Not marked decorative; no description provided."
    );
    expect(article.textContent).toContain("View slide for context");
    expect(article.querySelectorAll("img")).toHaveLength(1);
    expect(article.querySelector("img")?.getAttribute("src")).toBe(
      "data:image/png;base64,original"
    );
    await click(button("Restore original"));
    expect(article.textContent).toContain("Original will be used");
    await click(button("Check and download PowerPoint"));
    expect(lastSelection().includedChangeIds).toEqual([]);
  });

  it("edits only the wording in a grouped image-reading change while preserving the measured setting", async () => {
    const data = fixture();
    data.changes = [
      {
        id: "image-role",
        type: "decorative",
        slideNumber: 2,
        objectId: "image-1",
        label: "Read the image description",
        before: "Marked decorative; no description provided.",
        after:
          "Not marked decorative. Description: A diagram of the water cycle.",
        reason: "The diagram explains course content and needs a description.",
        operationIds: ["unmark-1", "describe-1"],
        editableDescription: true,
        descriptionBefore: "",
        descriptionAfter: "A diagram of the water cycle.",
      },
    ];
    data.includedChangeIds = ["image-role"];
    await mount(data);
    await click(button("Edit wording"));
    const textarea = host.querySelector("textarea")!;
    expect(textarea.value).toBe("A diagram of the water cycle.");
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value"
      )!.set!.call(textarea, "Water evaporates, condenses, and falls as rain.");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(button("Use this wording"));
    expect(host.querySelector("article")?.textContent).toContain(
      "Not marked decorative. Description: A diagram of the water cycle."
    );
    expect(host.querySelector("article")?.textContent).toContain(
      "Your edited description"
    );
    expect(host.querySelector("article")?.textContent).toContain(
      "The image’s reading setting stays as shown"
    );
    await click(button("Check and download PowerPoint"));
    expect(lastSelection().descriptionEdits).toEqual({
      "image-role": "Water evaporates, condenses, and falls as rain.",
    });
    await click(button("Restore original"));
    await click(button("Check and download PowerPoint"));
    expect(lastSelection().includedChangeIds).toEqual([]);
    expect(lastSelection().descriptionEdits).toEqual({});
  });

  it("shows added description slides separately from the original without inventing before images", async () => {
    const data = fixture();
    data.changes = [
      {
        id: "detail",
        type: "long-description",
        slideNumber: 5,
        objectId: "chart-1",
        label: "Add a detailed image description",
        before: "Chart with no description.",
        after:
          "Short description: Course participation; detailed explanation follows.\nAdded explanation: Participation rises from 20 to 35 students.",
        reason: "The chart's values need a longer explanation.",
        operationIds: ["long-description-1"],
        generatedSlideNumbers: [6, 7],
      },
    ];
    data.includedChangeIds = ["detail"];
    data.previewSlideNumbers = [5, 6, 7];
    vi.mocked(getPowerPointReviewPreview).mockImplementation(
      async (_document, _job, _token, slideNumber) =>
        slideNumber === 5
          ? {
              slideNumber,
              before: "data:image/png;base64,source",
              after: "data:image/png;base64,source-proposal",
            }
          : { slideNumber, after: `data:image/png;base64,added-${slideNumber}` }
    );
    await mount(data);
    const parent = host.querySelector("article details") as HTMLDetailsElement;
    await act(async () => {
      parent.open = true;
      parent.dispatchEvent(new Event("toggle"));
    });
    expect(host.querySelectorAll("article img")).toHaveLength(1);
    expect(getPowerPointReviewPreview).toHaveBeenCalledExactlyOnceWith(
      "doc-1",
      "job-1",
      "a".repeat(64),
      5
    );
    const added = parent.querySelectorAll("details");
    expect(added).toHaveLength(2);
    for (const disclosure of added) {
      await act(async () => {
        disclosure.open = true;
        disclosure.dispatchEvent(new Event("toggle"));
      });
    }
    expect(
      Array.from(host.querySelectorAll("article img")).map((image) =>
        image.getAttribute("src")
      )
    ).toEqual([
      "data:image/png;base64,source",
      "data:image/png;base64,added-6",
      "data:image/png;base64,added-7",
    ]);
    expect(host.textContent).toContain("Added description slide 6");
    expect(host.textContent).toContain("Added description slide 7");
    expect(host.textContent).toContain(
      "edit the explanation on those slides in PowerPoint"
    );
    expect(
      Array.from(host.querySelectorAll("button")).some(
        (item) => item.textContent === "Edit wording"
      )
    ).toBe(false);
    await click(button("Restore original"));
    expect(parent.textContent).toContain("Excluded from download");
    await click(button("Check and download PowerPoint"));
    expect(lastSelection().includedChangeIds).toEqual([]);
  });

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
    expect(host.textContent).toContain("With all suggested changes");
    await act(async () => {
      (disclosure as HTMLDetailsElement).open = false;
      disclosure.dispatchEvent(new Event("toggle"));
      (disclosure as HTMLDetailsElement).open = true;
      disclosure.dispatchEvent(new Event("toggle"));
    });
    expect(getPowerPointReviewPreview).toHaveBeenCalledOnce();
  });

  it("shows one original slide for descriptions and keeps comparisons for changes that may affect rendering", async () => {
    const data = fixture();
    data.previewSlideNumbers = [3, 5];
    vi.mocked(getPowerPointReviewPreview).mockImplementation(
      async (_documentId, _jobId, _revisionToken, slideNumber) => ({
        slideNumber,
        before: `data:image/png;base64,original-${slideNumber}`,
        after: `data:image/png;base64,updated-${slideNumber}`,
      })
    );
    await mount(data);
    const selectChange = async (label: string) => {
      const navigationButton = Array.from(
        host.querySelectorAll("nav button")
      ).find((item) => item.textContent?.includes(label))!;
      await click(navigationButton as HTMLElement);
      await act(async () => {
        const disclosure = host.querySelector(
          "article details"
        ) as HTMLDetailsElement;
        disclosure.open = true;
        disclosure.dispatchEvent(new Event("toggle"));
      });
    };

    await selectChange("Grading diagram description");
    expect(host.querySelector("article")?.textContent).toContain(
      "Original description"
    );
    expect(host.querySelector("article")?.textContent).toContain(
      "Suggested description"
    );
    expect(host.textContent).not.toContain("Your chosen version");
    expect(host.querySelector("article summary")?.textContent).toContain(
      "View slide for context"
    );
    expect(host.querySelectorAll("article img")).toHaveLength(1);
    expect(host.querySelector("article img")?.getAttribute("src")).toBe(
      "data:image/png;base64,original-5"
    );
    await click(button("Restore original"));
    expect(host.querySelector("article")?.textContent).toContain(
      "Original will be used"
    );
    expect(host.querySelector("article")?.textContent).toContain(
      "This suggestion is excluded"
    );
    expect(host.querySelector("article")?.textContent).toContain(
      data.changes[2].after
    );
    expect(host.querySelectorAll("article img")).toHaveLength(1);

    await selectChange("French pronunciation");
    expect(host.querySelectorAll("article img")).toHaveLength(2);
    expect(host.querySelector("article img")?.getAttribute("src")).toBe(
      "data:image/png;base64,original-3"
    );
    expect(host.querySelector("article summary")?.textContent).toContain(
      "Compare slide appearance"
    );
    expect(host.querySelector("article")?.textContent).toContain(
      "Suggested pronunciation setting"
    );
    expect(host.querySelector("article")?.textContent).toContain(
      "do not show your current selections"
    );

    await selectChange("Title before objectives");
    expect(host.querySelectorAll("article img")).toHaveLength(2);
    expect(host.querySelectorAll("article img")[1].getAttribute("src")).toBe(
      "data:image/png;base64,updated-3"
    );
    expect(getPowerPointReviewPreview).toHaveBeenCalledTimes(2);
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
    expect(button("Check and download PowerPoint").disabled).toBe(false);
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
      "Original will be used"
    );
    expect(host.querySelector("article")?.textContent).toContain(
      "may bring back a problem"
    );
    await click(button("Check and download PowerPoint"));
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
    await click(button("Check and download PowerPoint"));
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
    expect(host.querySelector("article")?.textContent).toContain(
      "Suggested description"
    );
    await click(button("Edit wording"));
    expect(button("Check and download PowerPoint").disabled).toBe(true);
    const textarea = host.querySelector("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value"
      )!.set!.call(textarea, "Homework counts for 15 percent of the grade.");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(button("Use this wording"));
    expect(host.querySelector("article")?.textContent).toContain(
      "Your edited description"
    );
    expect(host.querySelector("article")?.textContent).not.toContain(
      "Suggested description"
    );
    await click(button("Check and download PowerPoint"));
    expect(lastSelection().descriptionEdits).toEqual({
      description: "Homework counts for 15 percent of the grade.",
    });
    await click(button("Restore original"));
    expect(host.querySelector("article")?.textContent).toContain(
      "Your edited description"
    );
    expect(host.querySelector("article")?.textContent).toContain(
      "Original will be used"
    );
    await click(button("Check and download PowerPoint"));
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
      "This suggestion is excluded"
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
    const exportButton = button("Check and download PowerPoint");
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
    await click(button("Check and download PowerPoint"));
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
    await click(button("Check and download PowerPoint", document.body));
    expect(document.body.textContent).not.toContain(
      "The original output has an unresolved problem."
    );
    expect(onExportComplete).toHaveBeenCalledOnce();
  });
});
