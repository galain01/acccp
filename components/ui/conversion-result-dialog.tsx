"use client";

import { Info } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  getDocumentHtml,
  getDocumentOutputDownload,
} from "@/lib/actions/documents";
import {
  presentFinding,
  type AccessibilityError,
} from "@/lib/accessibility-findings";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "./accordion";
import { Badge } from "./badge";
import { Button } from "./button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./dialog";
import type { UploadedDocument } from "@/lib/types/document";
import type { PowerPointReviewExport } from "@/lib/powerpoint-review-contract";
import PowerPointChangeReview from "./powerpoint-change-review";

function formatIssueType(type: string): string {
  const spaced = type.replace(/-/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function FindingLocation({
  issue,
  isWord,
  isPowerPoint,
}: {
  issue: AccessibilityError;
  isWord: boolean;
  isPowerPoint: boolean;
}): React.JSX.Element {
  const location = issue.location;
  const pages = location?.sourcePages;
  const pageLabel = isWord ? "Converted PDF" : "PDF";
  const source =
    location?.scope === "document"
      ? "Whole document"
      : pages?.length
        ? isPowerPoint
          ? `${pages.length === 1 ? "Slide" : "Slides"} ${pages.join(", ")}`
          : `${pageLabel} ${pages.length === 1 ? "page" : "pages"} ${pages.join(", ")}`
        : isPowerPoint
          ? "We couldn't identify the slide."
          : "We couldn't identify the source page.";
  const details = [location?.section, location?.locator].filter(Boolean);

  return (
    <div className="mt-2">
      <p>
        <span className="font-medium">Where:</span> {source}
        {!isPowerPoint &&
          location?.printedPageLabel &&
          ` (printed page label: ${location.printedPageLabel})`}
        {details.length > 0 && ` · ${details.join(" · ")}`}
      </p>
      {location?.quote && (
        <p className="mt-1 break-words">
          <span className="font-medium">Near this text:</span> “{location.quote}
          ”
        </p>
      )}
    </div>
  );
}

interface ConversionResultDialogProps {
  document: UploadedDocument | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onReviewExport?: (result: PowerPointReviewExport) => void;
}

export default function ConversionResultDialog({
  document,
  open,
  onOpenChange,
  onReviewExport,
}: ConversionResultDialogProps): React.JSX.Element | null {
  const [copied, setCopied] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewedResult, setReviewedResult] =
    useState<PowerPointReviewExport | null>(null);
  const downloadPending = useRef(false);
  // undefined = not fetched yet, null = unavailable. Written only from the
  // async callbacks below, so the effect never sets state synchronously.
  const [fetchedHtml, setFetchedHtml] = useState<string | null | undefined>(
    undefined
  );

  // Documents restored from the database carry no html — it lives in storage
  // and is only worth fetching once someone actually opens the result.
  const documentId = document?.documentId;
  const isPowerPoint = document?.outputTarget === "accessible_pptx";
  const needsHtml =
    open && document?.status === "success" && !isPowerPoint && !document.html;
  const isLoadingHtml = Boolean(needsHtml) && fetchedHtml === undefined;

  useEffect(() => {
    if (!needsHtml || !documentId) return;

    let cancelled = false;
    getDocumentHtml(documentId)
      .then((html) => {
        if (!cancelled) setFetchedHtml(html);
      })
      .catch(() => {
        if (!cancelled) setFetchedHtml(null);
      });

    return () => {
      cancelled = true;
    };
  }, [needsHtml, documentId]);

  if (!document) return null;

  const html = document.html ?? fetchedHtml ?? undefined;
  const isSuccess = document.status === "success";
  const isError = document.status === "error";
  const issues = (reviewedResult?.findings ?? document.errors ?? []).map(
    presentFinding
  );
  const changeSummaries = reviewedResult?.changes ?? document.changes;
  const errorCount = issues.filter(
    (issue) => issue.severity === "error"
  ).length;
  const warningCount = issues.filter(
    (issue) => issue.severity === "warning"
  ).length;

  const handleCopy = async () => {
    if (!html) return;
    await navigator.clipboard.writeText(html);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownload = () => {
    if (!html) return;
    const blob = new Blob([html], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const anchor = window.document.createElement("a");
    anchor.href = url;
    anchor.download = `${document.name.replace(/\.(?:pdf|docx)$/i, "")}.html`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const handlePowerPointDownload = async () => {
    if (!documentId || downloadPending.current) return;
    downloadPending.current = true;
    setIsDownloading(true);
    setDownloadError(null);
    try {
      // Request a fresh signed URL on every click so it cannot expire while the
      // instructor is reading the findings. Ownership and expiry are server-checked.
      const download = await getDocumentOutputDownload(
        documentId,
        "accessible_pptx"
      );
      if (!download) {
        setDownloadError(
          "This online PowerPoint copy is unavailable. Online documents expire after 14 days. Re-upload the original to process it again; files on your computer are unaffected."
        );
        return;
      }
      const anchor = window.document.createElement("a");
      anchor.href = download.url;
      anchor.download = download.filename;
      anchor.click();
    } catch {
      setDownloadError(
        "The PowerPoint download could not be prepared. Please try again."
      );
    } finally {
      downloadPending.current = false;
      setIsDownloading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={`max-h-[calc(100dvh-2rem)] overflow-y-auto ${reviewOpen ? "sm:max-w-5xl" : "sm:max-w-2xl"}`}
      >
        <DialogHeader>
          <DialogTitle>{document.name}</DialogTitle>
          <DialogDescription>
            {isPowerPoint
              ? "PowerPoint accessibility improvements and items to review."
              : "Conversion result for this document."}
          </DialogDescription>
          {(errorCount > 0 || warningCount > 0) && (
            <div className="flex flex-wrap gap-1">
              {errorCount > 0 && (
                <Badge variant="destructive">Needs a fix: {errorCount}</Badge>
              )}
              {warningCount > 0 && (
                <Badge variant="warning">Please check: {warningCount}</Badge>
              )}
            </div>
          )}
        </DialogHeader>

        <div className="flex items-start gap-2 rounded-2xl border border-primary/30 bg-primary/5 p-3 text-sm">
          <Info className="mt-0.5 size-4 shrink-0 text-primary" />
          {isPowerPoint ? (
            <p>
              <span className="font-semibold text-primary">
                Review your updated PowerPoint
              </span>{" "}
              before sharing it. Run PowerPoint’s Accessibility Checker, compare
              the slides with your original, and work through the items below.
              Slide numbers refer to the order of slides in the presentation.
            </p>
          ) : (
            <p>
              <span className="font-semibold text-primary">
                Review your converted page
              </span>{" "}
              in Canvas before publishing. Compare it with your original
              document and work through the items below. Page numbers refer to
              the PDF used for conversion; the Canvas page does not have those
              page breaks.
              {/\.docx$/i.test(document.name) &&
                " The converted PDF may have different page breaks from Word."}
            </p>
          )}
        </div>

        {isError && document.errorMessage && (
          <p className="text-sm text-destructive">{document.errorMessage}</p>
        )}

        {isSuccess && isPowerPoint && errorCount > 0 && (
          <p role="status" className="text-sm text-destructive">
            This file still has accessibility problems that need a fix. Download
            it and address the items marked “Needs a fix” in PowerPoint before
            sharing it with students.
          </p>
        )}

        {isSuccess && !isPowerPoint && !html && (
          <p className="text-sm text-muted-foreground">
            {isLoadingHtml
              ? "Loading converted HTML…"
              : "This online HTML copy is unavailable. Online documents expire after 14 days; re-upload the original to convert it again. Files downloaded to your computer are unaffected. If the online copy has not expired or been deleted, try again."}
          </p>
        )}

        {isSuccess && !isPowerPoint && html && (
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap gap-2">
              <Button onClick={handleCopy}>
                {copied ? "Copied!" : "Copy HTML"}
              </Button>
              <Button variant="outline" onClick={handleDownload}>
                Download HTML
              </Button>
            </div>

            <Accordion>
              <AccordionItem value="html-output">
                <AccordionTrigger>View HTML output</AccordionTrigger>
                <AccordionContent>
                  <pre className="max-h-64 overflow-auto rounded-xl bg-muted p-3 text-xs whitespace-pre-wrap">
                    {html}
                  </pre>
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          </div>
        )}

        {isSuccess && isPowerPoint && (
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap gap-2">
              {!reviewOpen && (
                <Button
                  onClick={handlePowerPointDownload}
                  disabled={!documentId || isDownloading}
                >
                  {isDownloading
                    ? "Preparing download…"
                    : "Download PowerPoint"}
                </Button>
              )}
              {documentId && document.jobId && (
                <Button
                  variant="outline"
                  onClick={() => setReviewOpen((value) => !value)}
                >
                  {reviewOpen ? "Back to result" : "Review changes"}
                </Button>
              )}
              {downloadError && (
                <p role="alert" className="mt-2 text-sm text-destructive">
                  {downloadError}
                </p>
              )}
            </div>
            {reviewOpen && open && documentId && document.jobId ? (
              <PowerPointChangeReview
                key={`${documentId}:${document.jobId}`}
                documentId={documentId}
                jobId={document.jobId}
                onExportComplete={(result) => {
                  setReviewedResult(result);
                  onReviewExport?.(result);
                }}
              />
            ) : (
              <section aria-label="Changes made">
                <h2 className="mb-2 font-medium">Changes made</h2>
                {changeSummaries?.length ? (
                  <ul className="list-disc space-y-1 pl-5 text-sm">
                    {changeSummaries.map((change, index) => (
                      <li key={index}>{change}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    No automatic changes were reported. Review the presentation
                    and the items below.
                  </p>
                )}
              </section>
            )}
          </div>
        )}

        {isSuccess && issues.length > 0 && (
          <section aria-label="Items to review">
            <h2 className="mb-3 font-medium">
              Items to review ({issues.length})
            </h2>
            <ul className="flex flex-col gap-3">
              {issues.map((issue, index) => (
                <li
                  key={index}
                  className="rounded-xl border border-border p-3 text-sm"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge
                      variant={
                        issue.severity === "error" ? "destructive" : "warning"
                      }
                    >
                      {issue.severity === "error"
                        ? "Needs a fix"
                        : "Please check"}
                    </Badge>
                    <h3 className="font-medium">{issue.title}</h3>
                  </div>
                  <FindingLocation
                    issue={issue}
                    isWord={/\.docx$/i.test(document.name)}
                    isPowerPoint={isPowerPoint}
                  />
                  <p className="mt-2 break-words">
                    <span className="font-medium">What needs attention:</span>{" "}
                    {issue.message}
                  </p>
                  <p className="mt-2 break-words">
                    <span className="font-medium">What to do:</span>{" "}
                    {issue.suggestion}
                  </p>
                  <details className="mt-3 text-xs text-muted-foreground">
                    <summary className="cursor-pointer font-medium">
                      Technical details
                    </summary>
                    <p className="mt-2">Rule: {formatIssueType(issue.type)}</p>
                    {issue.category && <p>Category: {issue.category}</p>}
                    {issue.wcag && <p>{issue.wcag}</p>}
                    {issue.element && (
                      <code className="mt-1 block overflow-auto rounded bg-muted px-2 py-1 whitespace-pre-wrap">
                        {issue.element}
                      </code>
                    )}
                  </details>
                </li>
              ))}
            </ul>
          </section>
        )}
      </DialogContent>
    </Dialog>
  );
}
