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
import { readPdfInteractionTestSummary } from "@/lib/pdf-interaction-summary";
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
  isNativeWord,
}: {
  issue: AccessibilityError;
  isWord: boolean;
  isPowerPoint: boolean;
  isNativeWord: boolean;
}): React.JSX.Element {
  const location = issue.location;
  const pages = location?.sourcePages;
  const pageLabel = isNativeWord ? "Preview" : isWord ? "Converted PDF" : "PDF";
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
  const [reviewedSnapshot, setReviewedSnapshot] = useState<{
    documentId: string;
    artifactId?: string;
    result: PowerPointReviewExport;
  } | null>(null);
  const downloadPending = useRef(false);
  // undefined = not fetched yet, null = unavailable. Written only from the
  // async callbacks below, so the effect never sets state synchronously.
  const [fetchedHtmlSnapshot, setFetchedHtmlSnapshot] = useState<{
    documentId: string;
    artifactId?: string;
    html: string | null;
  }>();

  // Documents restored from the database carry no html — it lives in storage
  // and is only worth fetching once someone actually opens the result.
  const documentId = document?.documentId;
  const savedOutputArtifactId = document?.savedOutputArtifactId;
  const fetchedHtml =
    fetchedHtmlSnapshot?.documentId === documentId &&
    fetchedHtmlSnapshot?.artifactId === savedOutputArtifactId
      ? fetchedHtmlSnapshot?.html
      : undefined;
  const reviewedResult =
    reviewedSnapshot?.documentId === documentId &&
    reviewedSnapshot?.artifactId === savedOutputArtifactId
      ? reviewedSnapshot?.result
      : undefined;
  // Listed artifacts always fetch their exact immutable bytes. Inline HTML is
  // only supplied by the initial conversion response, which has no artifact ID.
  const inlineHtml = savedOutputArtifactId ? undefined : document?.html;
  const isPowerPoint = document?.outputTarget === "accessible_pptx";
  const isNativeWord = document?.outputTarget === "accessible_docx";
  const isNativePdf = document?.outputTarget === "accessible_pdf";
  const isNative = isPowerPoint || isNativeWord || isNativePdf;
  const nativeLabel = isNativeWord
    ? "Word document"
    : isNativePdf
      ? "PDF"
      : "PowerPoint";
  const hasSavedResult =
    document?.status === "success" ||
    (document?.status === "error" && document.hasAvailableOutput === true);
  const needsHtml = open && hasSavedResult && !isNative && !inlineHtml;
  const isLoadingHtml = Boolean(needsHtml) && fetchedHtml === undefined;

  useEffect(() => {
    if (!needsHtml || !documentId) return;

    let cancelled = false;
    const request = savedOutputArtifactId
      ? getDocumentHtml(documentId, savedOutputArtifactId)
      : getDocumentHtml(documentId);
    request
      .then((html) => {
        if (!cancelled)
          setFetchedHtmlSnapshot({
            documentId,
            artifactId: savedOutputArtifactId,
            html,
          });
      })
      .catch(() => {
        if (!cancelled)
          setFetchedHtmlSnapshot({
            documentId,
            artifactId: savedOutputArtifactId,
            html: null,
          });
      });

    return () => {
      cancelled = true;
    };
  }, [needsHtml, documentId, savedOutputArtifactId]);

  if (!document) return null;

  const html = inlineHtml ?? fetchedHtml ?? undefined;
  const isSuccess = document.status === "success";
  const isError = document.status === "error";
  const isPreviousResult = isError && hasSavedResult;
  const resultLabel = document.savedResultUnverified ? "saved" : "previous";
  const interactionTestSummary =
    isSuccess && isNativePdf && !document.savedResultUnverified
      ? readPdfInteractionTestSummary(document.interactionTestSummary)
      : undefined;
  const issues = (
    document.savedResultUnverified
      ? []
      : (reviewedResult?.findings ?? document.errors ?? [])
  ).map(presentFinding);
  const changeSummaries = document.savedResultUnverified
    ? undefined
    : (reviewedResult?.changes ?? document.changes);
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

  const handleNativeDownload = async () => {
    if (!documentId || downloadPending.current) return;
    downloadPending.current = true;
    setIsDownloading(true);
    setDownloadError(null);
    try {
      // Request a fresh signed URL on every click so it cannot expire while the
      // instructor is reading the findings. Ownership and expiry are server-checked.
      const target = isNativeWord
        ? "accessible_docx"
        : isNativePdf
          ? "accessible_pdf"
          : "accessible_pptx";
      const download = savedOutputArtifactId
        ? await getDocumentOutputDownload(
            documentId,
            target,
            savedOutputArtifactId
          )
        : await getDocumentOutputDownload(documentId, target);
      if (!download) {
        setDownloadError(
          savedOutputArtifactId
            ? `This saved ${nativeLabel} result changed or is no longer available. Refresh the page to load the current result and its review. Online documents expire after 14 days; files on your computer are unaffected.`
            : `This online ${nativeLabel} copy is unavailable. Online documents expire after 14 days. Re-upload the original to process it again; files on your computer are unaffected.`
        );
        return;
      }
      const anchor = window.document.createElement("a");
      anchor.href = download.url;
      anchor.download = download.filename;
      anchor.click();
    } catch {
      setDownloadError(
        `The ${nativeLabel} download could not be prepared. Please try again.`
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
            {isNative
              ? `${nativeLabel} accessibility improvements and items to review.`
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
          ) : isNativeWord ? (
            <p>
              <span className="font-semibold text-primary">
                Review your updated Word document
              </span>{" "}
              before sharing it. Run Word’s Accessibility Checker and review the
              changes and remaining questions below. Lists and table headings
              may have small formatting changes to improve navigation while
              keeping the surrounding layout. Page references use the app’s
              preview; Word may paginate differently on your computer.
            </p>
          ) : isNativePdf ? (
            <p>
              <span className="font-semibold text-primary">
                Review your repaired PDF
              </span>{" "}
              before sharing it. The app checks the file and asks an independent
              AI reviewer to compare it with your original. Review the changes
              and remaining questions below
              {interactionTestSummary
                ? "."
                : ", including reading order, image descriptions, and any form fields."}{" "}
              Automatic checks do not certify PDF accessibility. Page numbers
              count from the first page.
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

        {isPreviousResult && (
          <p role="status" className="text-sm">
            {document.savedResultUnverified
              ? "A saved result may still be available. Refresh the page to load its current status and review findings."
              : "The previous saved result is still available. Its changes and review findings below belong to that earlier result."}
          </p>
        )}

        {hasSavedResult && isNative && errorCount > 0 && (
          <p role="status" className="text-sm text-destructive">
            This file still has accessibility problems that need a fix. Download
            it and address the items marked “Needs a fix” in{" "}
            {isNativeWord
              ? "Word"
              : isNativePdf
                ? "a PDF editor"
                : "PowerPoint"}{" "}
            before sharing it with students.
          </p>
        )}

        {hasSavedResult && !isNative && !html && (
          <p className="text-sm text-muted-foreground">
            {isLoadingHtml
              ? "Loading converted HTML…"
              : savedOutputArtifactId
                ? "This saved HTML result changed or is no longer available. Refresh the page to load the current result and its review. Online documents expire after 14 days; files downloaded to your computer are unaffected."
                : "This online HTML copy is unavailable. Online documents expire after 14 days; re-upload the original to convert it again. Files downloaded to your computer are unaffected. If the online copy has not expired or been deleted, try again."}
          </p>
        )}

        {hasSavedResult && !isNative && html && (
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap gap-2">
              <Button onClick={handleCopy}>
                {copied
                  ? "Copied!"
                  : isPreviousResult
                    ? `Copy ${resultLabel} HTML`
                    : "Copy HTML"}
              </Button>
              <Button variant="outline" onClick={handleDownload}>
                {isPreviousResult
                  ? `Download ${resultLabel} HTML`
                  : "Download HTML"}
              </Button>
            </div>

            <Accordion>
              <AccordionItem value="html-output">
                <AccordionTrigger>
                  {isPreviousResult
                    ? `View ${resultLabel} HTML output`
                    : "View HTML output"}
                </AccordionTrigger>
                <AccordionContent>
                  <pre className="max-h-64 overflow-auto rounded-xl bg-muted p-3 text-xs whitespace-pre-wrap">
                    {html}
                  </pre>
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          </div>
        )}

        {hasSavedResult && isNative && (
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap gap-2">
              {!reviewOpen && (
                <Button
                  onClick={handleNativeDownload}
                  disabled={!documentId || isDownloading}
                >
                  {isDownloading
                    ? "Preparing download…"
                    : isPreviousResult
                      ? `Download ${resultLabel} ${isNativeWord ? "Word document" : isNativePdf ? "repaired PDF" : "PowerPoint"}`
                      : isNativeWord
                        ? "Download Word document"
                        : isNativePdf
                          ? "Download repaired PDF"
                          : "Download PowerPoint"}
                </Button>
              )}
              {isSuccess && isPowerPoint && documentId && document.jobId && (
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
            {isSuccess &&
            isPowerPoint &&
            reviewOpen &&
            open &&
            documentId &&
            document.jobId ? (
              <PowerPointChangeReview
                key={`${documentId}:${document.jobId}:${savedOutputArtifactId ?? ""}`}
                documentId={documentId}
                jobId={document.jobId}
                onExportComplete={(result) => {
                  setReviewedSnapshot({
                    documentId,
                    artifactId:
                      result.savedOutputArtifactId ?? savedOutputArtifactId,
                    result,
                  });
                  onReviewExport?.(result);
                }}
              />
            ) : !document.savedResultUnverified ? (
              <section aria-label="Changes made">
                <h2 className="mb-2 font-medium">
                  {isPreviousResult
                    ? "Changes in the previous result"
                    : "Changes made"}
                </h2>
                {changeSummaries?.length ? (
                  <ul className="list-disc space-y-1 pl-5 text-sm">
                    {changeSummaries.map((change, index) => (
                      <li key={index}>{change}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    No automatic changes were reported. Review the document and
                    the items below.
                  </p>
                )}
              </section>
            ) : null}
          </div>
        )}

        {interactionTestSummary && (
          <section aria-label="Previously tested form behavior">
            <h2 className="mb-2 font-medium">
              Previously tested form behavior
            </h2>
            <p className="text-sm">
              Tested on{" "}
              <time dateTime={interactionTestSummary.testedAt}>
                {interactionTestSummary.testedAt}
              </time>{" "}
              with {interactionTestSummary.environment}.
            </p>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
              {interactionTestSummary.passedChecks.map((check) => (
                <li key={check}>{check}</li>
              ))}
            </ul>
            <p className="mt-2 text-sm text-muted-foreground">
              {interactionTestSummary.scopeNote}
            </p>
          </section>
        )}

        {hasSavedResult && issues.length > 0 && (
          <section aria-label="Items to review">
            <h2 className="mb-3 font-medium">
              {isPreviousResult
                ? "Items to review in the previous result"
                : "Items to review"}{" "}
              ({issues.length})
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
                    isNativeWord={isNativeWord}
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
