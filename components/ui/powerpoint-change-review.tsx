"use client";

import Image from "next/image";
import { useEffect, useId, useRef, useState } from "react";
import {
  getPowerPointReview,
  getPowerPointReviewPreview,
} from "@/lib/actions/powerpoint-review";
import type {
  PowerPointReviewData,
  PowerPointReviewExport,
  PowerPointReviewPreview,
} from "@/lib/powerpoint-review-contract";
import type { PptxRevisionChange } from "@/lib/pptx-types";
import { Badge } from "./badge";
import { Button } from "./button";

interface PowerPointChangeReviewProps {
  documentId: string;
  jobId: string;
  onExportComplete: (result: PowerPointReviewExport) => void;
}

const unavailableMessage =
  "The change history is unavailable for this conversion. Online copies expire after 14 days. An older conversion may need to be run again to create a change history.";

type PreviewState =
  | { status: "loading" | "error" | "unavailable" }
  | { status: "ready"; preview: PowerPointReviewPreview };

const changeCopy: Record<
  PptxRevisionChange["type"],
  { original: string; suggested: string; help: string; contextOnly: boolean }
> = {
  title: {
    original: "Original title setting",
    suggested: "Suggested title setting",
    help: "Identifying a slide’s title helps students using software that reads aloud recognize its topic and navigate the presentation.",
    contextOnly: false,
  },
  description: {
    original: "Original description",
    suggested: "Suggested description",
    help: "A description is text that reading software uses to explain this item. Changing the description does not change how the slide looks.",
    contextOnly: true,
  },
  decorative: {
    original: "Original image reading setting",
    suggested: "Suggested image reading setting",
    help: "An image marked decorative stays visible, but software that reads slides aloud skips it. Use that setting only when skipping the image will not lose information students need.",
    contextOnly: true,
  },
  "long-description": {
    original: "Original image description",
    suggested: "Suggested detailed description",
    help: "A complex image may need more explanation than a short description can provide. This change adds editable slides with a detailed explanation and updates the image’s short description to point students to them. Check the explanation against the image and your teaching intent.",
    contextOnly: true,
  },
  "table-header": {
    original: "Original table header setting",
    suggested: "Suggested table header setting",
    help: "Table headers are the labels that explain each row or column. Identifying them helps reading software connect those labels with the table’s values.",
    contextOnly: false,
  },
  "table-caption": {
    original: "Original table structure",
    suggested: "Suggested table structure",
    help: "A table’s caption explains its overall topic; column labels explain the values below them. Separating these gives students a clearer way to understand the table.",
    contextOnly: false,
  },
  "reading-order": {
    original: "Original reading order",
    suggested: "Suggested reading order",
    help: "Reading order is the sequence students hear when software reads the slide aloud. Changing that sequence can also affect which item appears in front when items overlap.",
    contextOnly: false,
  },
  language: {
    original: "Original pronunciation setting",
    suggested: "Suggested pronunciation setting",
    help: "This setting tells reading software which language to use for pronunciation. The visible words stay the same; check the preview for any layout changes.",
    contextOnly: false,
  },
  "link-text": {
    original: "Original link wording",
    suggested: "Suggested link wording",
    help: "Clear link wording tells students where a link leads. The suggested wording keeps the same destination.",
    contextOnly: false,
  },
  "text-style": {
    original: "Original text appearance",
    suggested: "Suggested text appearance",
    help: "Text size and color affect how easily students can read a slide. Check that the suggested appearance is clear and still fits the surrounding content.",
    contextOnly: false,
  },
  position: {
    original: "Original placement",
    suggested: "Suggested placement",
    help: "Moving or resizing an item can improve spacing or keep content on the slide. Check that important content remains visible and its relationship to nearby items is clear.",
    contextOnly: false,
  },
};

export default function PowerPointChangeReview(
  props: PowerPointChangeReviewProps
): React.JSX.Element {
  const [review, setReview] = useState<PowerPointReviewData | null>();
  const [loadError, setLoadError] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    getPowerPointReview(props.documentId, props.jobId)
      .then((data) => {
        if (!cancelled) setReview(data);
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [props.documentId, props.jobId, attempt]);

  if (loadError) {
    return (
      <div role="alert" className="space-y-2 text-sm">
        <p>The change history could not be loaded. Please try again.</p>
        <Button
          variant="outline"
          onClick={() => {
            setLoadError(false);
            setAttempt((value) => value + 1);
          }}
        >
          Try again
        </Button>
      </div>
    );
  }
  if (review === undefined) {
    return <p role="status">Loading the changes made to your PowerPoint…</p>;
  }
  if (!review) return <p role="status">{unavailableMessage}</p>;

  return <ReviewChoices {...props} review={review} />;
}

function ReviewChoices({
  review,
  documentId,
  jobId,
  onExportComplete,
}: PowerPointChangeReviewProps & { review: PowerPointReviewData }) {
  const ordered = [...review.changes].sort(
    (left, right) =>
      Number(Boolean(right.assumption)) - Number(Boolean(left.assumption)) ||
      left.slideNumber - right.slideNumber
  );
  const [selectedId, setSelectedId] = useState(ordered[0]?.id);
  const [revisionToken, setRevisionToken] = useState(review.revisionToken);
  const [included, setIncluded] = useState(new Set(review.includedChangeIds));
  const [reviewed, setReviewed] = useState(new Set(review.reviewedChangeIds));
  const [descriptionEdits, setDescriptionEdits] = useState(
    review.descriptionEdits
  );
  const [draft, setDraft] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportMessage, setExportMessage] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [previewCache, setPreviewCache] = useState<
    Record<number, PreviewState>
  >({});
  const pendingPreviews = useRef(new Set<number>());
  const pending = useRef(false);
  const mounted = useRef(false);
  const inputId = useId();
  const selected = review.changes.find((change) => change.id === selectedId);
  const selectedCopy = selected ? changeCopy[selected.type] : undefined;
  const generatedSlideNumbers = selected?.generatedSlideNumbers ?? [];
  const isLongDescription = selected?.type === "long-description";
  const suppliedPreview = review.previews?.find(
    (item) => item.slideNumber === selected?.slideNumber
  );
  const previewState = selected
    ? previewCache[selected.slideNumber]
    : undefined;
  const preview =
    suppliedPreview ??
    (previewState?.status === "ready" ? previewState.preview : undefined);
  const canPreview = Boolean(
    suppliedPreview ||
    (selected && review.previewSlideNumbers?.includes(selected.slideNumber)) ||
    generatedSlideNumbers.some(
      (slideNumber) =>
        review.previewSlideNumbers?.includes(slideNumber) ||
        review.previews?.some((item) => item.slideNumber === slideNumber)
    )
  );
  const assumptions = ordered.filter((change) => change.assumption);
  const routine = ordered.filter((change) => !change.assumption);
  const remaining = assumptions.filter(
    (change) => !reviewed.has(change.id)
  ).length;
  const allIncluded = included.size === review.changes.length;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const loadPreview = async (slideNumber: number) => {
    if (pendingPreviews.current.has(slideNumber)) return;
    pendingPreviews.current.add(slideNumber);
    setPreviewCache((previous) => ({
      ...previous,
      [slideNumber]: { status: "loading" },
    }));
    try {
      const image = await getPowerPointReviewPreview(
        documentId,
        jobId,
        revisionToken,
        slideNumber
      );
      if (mounted.current) {
        setPreviewCache((previous) => ({
          ...previous,
          [slideNumber]: image
            ? { status: "ready", preview: image }
            : { status: "unavailable" },
        }));
      }
    } catch {
      if (mounted.current) {
        setPreviewCache((previous) => ({
          ...previous,
          [slideNumber]: { status: "error" },
        }));
      }
    } finally {
      pendingPreviews.current.delete(slideNumber);
    }
  };

  const choose = (change: PptxRevisionChange, keep: boolean) => {
    setIncluded((previous) => {
      const next = new Set(previous);
      if (keep) next.add(change.id);
      else next.delete(change.id);
      return next;
    });
    setReviewed((previous) => new Set(previous).add(change.id));
    setDirty(true);
    setExportMessage(null);
  };

  const exportChoices = async () => {
    if (pending.current || draft !== null) return;
    pending.current = true;
    setExporting(true);
    setExportError(null);
    setExportMessage(null);
    try {
      const response = await fetch("/api/powerpoint-review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          documentId,
          jobId,
          revisionToken,
          includedChangeIds: review.changes
            .filter((change) => included.has(change.id))
            .map((change) => change.id),
          reviewedChangeIds: review.changes
            .filter((change) => reviewed.has(change.id))
            .map((change) => change.id),
          descriptionEdits: Object.fromEntries(
            Object.entries(descriptionEdits).filter(([id]) => included.has(id))
          ),
        }),
      });
      if (!mounted.current) return;
      if (!response.ok) {
        setExportError(
          response.status === 409
            ? "This conversion changed while you were reviewing it. Close the result and open it again to load the current changes."
            : response.status === 404 || response.status === 410
              ? "This online copy is no longer available. Online documents expire after 14 days; re-upload your original to process it again."
              : "The PowerPoint with your selections could not be prepared. Your choices are still here; please try again."
        );
        return;
      }
      const result: PowerPointReviewExport = await response.json();
      if (!mounted.current) return;
      onExportComplete(result);
      setRevisionToken(result.revisionToken);
      setDirty(false);
      const count = result.findings.length;
      setExportMessage(
        count
          ? `Your PowerPoint was checked and saved with your selections. The download has started. ${count} ${count === 1 ? "item still needs" : "items still need"} attention; see the updated items below.`
          : "Your PowerPoint was checked and saved with your selections. The download has started. The checks reported no remaining items."
      );
      const anchor = window.document.createElement("a");
      anchor.href = result.url;
      anchor.download = result.filename;
      anchor.click();
    } catch {
      if (mounted.current) {
        setExportError(
          "The download could not be completed. Your choices are still here; please try again."
        );
      }
    } finally {
      pending.current = false;
      if (mounted.current) setExporting(false);
    }
  };

  const changeButton = (change: PptxRevisionChange) => (
    <li key={change.id}>
      <button
        type="button"
        aria-current={selectedId === change.id ? "true" : undefined}
        disabled={exporting || draft !== null}
        onClick={() => setSelectedId(change.id)}
        className="min-h-11 w-full rounded-lg border border-transparent p-2 text-left text-sm hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50 aria-current:border-primary aria-current:bg-primary/5"
      >
        <span className="block font-medium">
          Slide {change.slideNumber} · {change.label}
        </span>
        <span className="block text-xs text-muted-foreground">
          {included.has(change.id)
            ? "Included in download"
            : "Original will be used"}
          {reviewed.has(change.id) ? " · Reviewed" : " · Not reviewed"}
        </span>
      </button>
    </li>
  );

  return (
    <section aria-label="Review PowerPoint changes" className="space-y-4">
      <div>
        <h2 className="font-semibold">Review changes</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          All suggested changes are included by default. Start with assumptions
          about your teaching intent; routine repairs are grouped below. A
          change is marked Reviewed after you keep it, restore the original, or
          use your own wording.
        </p>
        <p className="mt-2 text-sm" role="status">
          {included.size} of {review.changes.length} changes included ·{" "}
          {reviewed.size} reviewed
          {remaining > 0 &&
            ` · ${remaining} ${remaining === 1 ? "assumption" : "assumptions"} to review`}
        </p>
      </div>

      {selected ? (
        <div className="grid items-start gap-4 md:grid-cols-[15rem_minmax(0,1fr)]">
          <nav
            aria-label="Changes in this presentation"
            className="min-w-0 space-y-3"
          >
            {assumptions.length > 0 && (
              <div>
                <h3 className="mb-2 text-sm font-medium">
                  Check these assumptions
                </h3>
                <ul className="space-y-1">{assumptions.map(changeButton)}</ul>
              </div>
            )}
            {routine.length > 0 && (
              <details open={assumptions.length === 0}>
                <summary className="min-h-11 cursor-pointer py-3 text-sm font-medium">
                  Routine repairs ({routine.length})
                </summary>
                <ul className="space-y-1">{routine.map(changeButton)}</ul>
              </details>
            )}
          </nav>

          <article
            aria-label={`Change: ${selected.label}`}
            className="min-w-0 space-y-4 rounded-xl border p-4"
          >
            <div>
              <p className="text-sm text-muted-foreground">
                Slide {selected.slideNumber}
              </p>
              <h3 className="mt-1 font-semibold">{selected.label}</h3>
              <div className="mt-2 flex flex-wrap gap-2">
                <Badge
                  variant={included.has(selected.id) ? "secondary" : "outline"}
                >
                  {included.has(selected.id)
                    ? "Included in download"
                    : "Original will be used"}
                </Badge>
                <Badge variant="outline">
                  {reviewed.has(selected.id) ? "Reviewed" : "Not reviewed"}
                </Badge>
              </div>
            </div>
            <p className="text-sm text-muted-foreground">
              {selectedCopy?.help}
            </p>
            {selected.assumption && (
              <div className="rounded-lg bg-primary/5 p-3 text-sm">
                <h4 className="font-medium">Does this match your intention?</h4>
                <p className="mt-1 break-words whitespace-pre-wrap">
                  {selected.assumption}
                </p>
              </div>
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              <section
                aria-label="Before this change"
                className="min-w-0 rounded-lg bg-muted p-3"
              >
                <h4 className="text-sm font-medium">
                  {selectedCopy?.original}
                </h4>
                <p className="mt-2 text-sm break-words whitespace-pre-wrap">
                  {selected.before ||
                    (selected.type === "description"
                      ? "No description was provided."
                      : "No value was set.")}
                </p>
              </section>
              <section
                aria-label="After this change"
                className="min-w-0 rounded-lg border border-primary/30 bg-primary/5 p-3"
              >
                <h4 className="text-sm font-medium">
                  {selected.type === "description" &&
                  descriptionEdits[selected.id] !== undefined
                    ? "Your edited description"
                    : selectedCopy?.suggested}
                </h4>
                <p className="mt-2 text-sm break-words whitespace-pre-wrap">
                  {selected.type === "description"
                    ? (descriptionEdits[selected.id] ?? selected.after)
                    : selected.after}
                </p>
                {selected.type === "decorative" &&
                  descriptionEdits[selected.id] !== undefined && (
                    <div className="mt-3 border-t border-primary/20 pt-3">
                      <h5 className="text-sm font-medium">
                        Your edited description
                      </h5>
                      <p className="mt-1 text-sm break-words whitespace-pre-wrap">
                        {descriptionEdits[selected.id]}
                      </p>
                      <p className="mt-2 text-xs text-muted-foreground">
                        This wording replaces the suggested description above.
                        The image’s reading setting stays as shown.
                      </p>
                    </div>
                  )}
                {!included.has(selected.id) && (
                  <p className="mt-2 text-sm font-medium">
                    This suggestion is excluded. The original will be used in
                    your download.
                  </p>
                )}
              </section>
            </div>
            <div className="text-sm">
              <h4 className="font-medium">Why this change is suggested</h4>
              <p className="mt-1 break-words whitespace-pre-wrap">
                {selected.reason}
              </p>
              {selected.operationIds.length > 1 && (
                <p className="mt-2 text-muted-foreground">
                  These related edits work together and will be kept or restored
                  as one change.
                </p>
              )}
            </div>
            {canPreview && (
              <details
                key={selected.slideNumber}
                onToggle={(event) => {
                  if (
                    event.currentTarget.open &&
                    !suppliedPreview &&
                    !previewState
                  ) {
                    void loadPreview(selected.slideNumber);
                  }
                }}
              >
                <summary className="min-h-11 cursor-pointer py-3 text-sm font-medium">
                  {selectedCopy?.contextOnly
                    ? isLongDescription
                      ? "View original and added description slides"
                      : "View slide for context"
                    : "Compare slide appearance"}
                </summary>
                <p className="mb-2 text-xs text-muted-foreground">
                  {selectedCopy?.contextOnly
                    ? isLongDescription
                      ? "The original slide is shown for context. Each added slide below shows the suggested explanation as it would appear in PowerPoint. These reference previews stay the same when you keep or restore the change. Slide numbers refer to all suggested changes and may shift in your download if you exclude other added slides."
                      : selected.type === "decorative"
                        ? "Use this original slide to decide whether the image carries information students need. Changing whether reading software skips the image, or updating its description, leaves the image visible and does not change how the slide looks."
                        : "Use this original slide to check whether the description above explains the important information. The description changes what reading software can read aloud; it does not change the slide’s appearance."
                    : "These reference images show the original slide and the slide with all suggested changes. They stay the same when you keep or restore a change or edit a description, so they do not show your current selections."}
                </p>
                {!preview &&
                  (!previewState || previewState.status === "loading") && (
                    <p role="status" className="text-sm">
                      Loading this slide’s preview…
                    </p>
                  )}
                {previewState?.status === "error" && (
                  <div className="space-y-2 text-sm">
                    <p role="alert">
                      This slide preview could not be loaded. You can still keep
                      or restore the change using the text comparison above.
                    </p>
                    <Button
                      variant="outline"
                      onClick={() => void loadPreview(selected.slideNumber)}
                    >
                      Try preview again
                    </Button>
                  </div>
                )}
                {previewState?.status === "unavailable" && (
                  <p role="status" className="text-sm">
                    This slide preview is unavailable. You can still keep or
                    restore the change using the text comparison above.
                  </p>
                )}
                {preview && (
                  <div
                    className={`grid gap-3 ${selectedCopy?.contextOnly ? "" : "sm:grid-cols-2"}`}
                  >
                    {(selectedCopy?.contextOnly
                      ? (["before"] as const)
                      : (["before", "after"] as const)
                    )
                      .filter((side) => Boolean(preview[side]))
                      .map((side) => (
                        <figure key={side}>
                          <Image
                            src={preview[side]!}
                            width={960}
                            height={540}
                            unoptimized
                            alt={`Slide ${selected.slideNumber}: ${side === "before" ? "original appearance" : "appearance with all suggested changes"}`}
                            className="h-auto w-full rounded border"
                          />
                          <figcaption className="mt-1 text-xs">
                            {side === "before"
                              ? "Original slide"
                              : "With all suggested changes"}
                          </figcaption>
                        </figure>
                      ))}
                  </div>
                )}
                {isLongDescription &&
                  generatedSlideNumbers.map((slideNumber) => {
                    const addedState = previewCache[slideNumber];
                    const addedPreview =
                      review.previews?.find(
                        (item) => item.slideNumber === slideNumber
                      ) ??
                      (addedState?.status === "ready"
                        ? addedState.preview
                        : undefined);
                    return (
                      <details
                        key={slideNumber}
                        className="mt-3 rounded-lg border p-3"
                        onToggle={(event) => {
                          if (
                            event.currentTarget.open &&
                            !addedPreview &&
                            !addedState
                          )
                            void loadPreview(slideNumber);
                        }}
                      >
                        <summary className="min-h-11 cursor-pointer py-3 text-sm font-medium">
                          Added description slide {slideNumber}
                        </summary>
                        {addedPreview ? (
                          <figure>
                            <Image
                              src={addedPreview.after}
                              width={960}
                              height={540}
                              unoptimized
                              alt={`Added description slide ${slideNumber} with the suggested explanation`}
                              className="h-auto w-full rounded border"
                            />
                            <figcaption className="mt-1 text-xs">
                              Added description slide {slideNumber} ·{" "}
                              {included.has(selected.id)
                                ? "Included in download"
                                : "Excluded from download"}
                            </figcaption>
                          </figure>
                        ) : addedState?.status === "error" ? (
                          <div className="space-y-2 text-sm">
                            <p role="alert">
                              This added slide preview could not be loaded. The
                              explanation is still available in the text
                              comparison above.
                            </p>
                            <Button
                              variant="outline"
                              onClick={() => void loadPreview(slideNumber)}
                            >
                              Try slide {slideNumber} preview again
                            </Button>
                          </div>
                        ) : addedState?.status === "unavailable" ? (
                          <p role="status" className="text-sm">
                            This added slide preview is unavailable. The
                            explanation is still available in the text
                            comparison above.
                          </p>
                        ) : (
                          <p role="status" className="text-sm">
                            Loading added description slide {slideNumber}…
                          </p>
                        )}
                      </details>
                    );
                  })}
              </details>
            )}
            {isLongDescription && (
              <p className="text-sm text-muted-foreground">
                The image’s description and its added explanation slides are
                kept or restored together. After downloading, you can edit the
                explanation on those slides in PowerPoint.
              </p>
            )}

            {draft !== null ? (
              <div className="space-y-2">
                <label htmlFor={inputId} className="block text-sm font-medium">
                  Description students will hear
                </label>
                <textarea
                  id={inputId}
                  value={draft}
                  maxLength={2000}
                  rows={5}
                  onChange={(event) => setDraft(event.target.value)}
                  className="w-full rounded-lg border border-input p-3 text-sm focus-visible:outline-2 focus-visible:outline-ring"
                />
                <div className="flex flex-wrap gap-2">
                  <Button
                    disabled={!draft.trim()}
                    onClick={() => {
                      setDescriptionEdits((previous) => ({
                        ...previous,
                        [selected.id]: draft.trim(),
                      }));
                      choose(selected, true);
                      setDraft(null);
                    }}
                  >
                    Use this wording
                  </Button>
                  <Button variant="outline" onClick={() => setDraft(null)}>
                    Cancel edit
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Your wording will be included and checked before you download
                  the PowerPoint.
                </p>
              </div>
            ) : (
              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={exporting}
                  onClick={() => choose(selected, true)}
                >
                  Keep change
                </Button>
                <Button
                  variant="outline"
                  disabled={exporting}
                  onClick={() => choose(selected, false)}
                >
                  Restore original
                </Button>
                {selected.editableDescription && !isLongDescription && (
                  <Button
                    variant="outline"
                    disabled={exporting}
                    onClick={() =>
                      setDraft(
                        descriptionEdits[selected.id] ??
                          selected.descriptionAfter ??
                          selected.after
                      )
                    }
                  >
                    Edit wording
                  </Button>
                )}
              </div>
            )}
            {!included.has(selected.id) && (
              <p role="status" className="text-sm text-muted-foreground">
                Restoring the original may bring back a problem. The PowerPoint
                will be checked with your selections before download.
              </p>
            )}
          </article>
        </div>
      ) : (
        <p className="text-sm">
          No applied changes were recorded for this presentation. You can still
          check and download it.
        </p>
      )}

      <div className="space-y-2 border-t pt-4">
        <Button
          className="h-auto min-h-11 py-2 whitespace-normal"
          disabled={exporting || draft !== null}
          onClick={exportChoices}
        >
          {exporting
            ? "Checking your PowerPoint…"
            : "Check and download PowerPoint"}
        </Button>
        <p className="text-xs text-muted-foreground">
          {dirty ? "Your choices have not been saved yet. " : ""}
          Choices are saved when you check and download. Closing this review
          discards unsaved choices. The original upload is kept until its 14-day
          expiry.
        </p>
        {!allIncluded && (
          <p className="text-xs text-muted-foreground">
            Changes you restored will be excluded from your download.
          </p>
        )}
        {exportMessage && (
          <p role="status" className="text-sm">
            {exportMessage}
          </p>
        )}
        {exportError && (
          <p role="alert" className="text-sm text-destructive">
            {exportError}
          </p>
        )}
      </div>
    </section>
  );
}
