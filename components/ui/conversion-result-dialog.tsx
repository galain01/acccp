"use client";

import { Info } from "lucide-react";
import { useEffect, useState } from "react";
import { getDocumentHtml } from "@/lib/actions/documents";
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

function formatIssueType(type: string): string {
  const spaced = type.replace(/-/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function FindingLocation({
  issue,
  isWord,
}: {
  issue: AccessibilityError;
  isWord: boolean;
}): React.JSX.Element {
  const location = issue.location;
  const pages = location?.sourcePages;
  const pageLabel = isWord ? "Converted PDF" : "PDF";
  const source =
    location?.scope === "document"
      ? "Whole document"
      : pages?.length
        ? `${pageLabel} ${pages.length === 1 ? "page" : "pages"} ${pages.join(", ")}`
        : "We couldn't identify the source page.";
  const details = [location?.section, location?.locator].filter(Boolean);

  return (
    <div className="mt-2">
      <p>
        <span className="font-medium">Where:</span> {source}
        {location?.printedPageLabel &&
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
}

export default function ConversionResultDialog({
  document,
  open,
  onOpenChange,
}: ConversionResultDialogProps): React.JSX.Element | null {
  const [copied, setCopied] = useState(false);
  // undefined = not fetched yet, null = unavailable. Written only from the
  // async callbacks below, so the effect never sets state synchronously.
  const [fetchedHtml, setFetchedHtml] = useState<string | null | undefined>(
    undefined
  );

  // Documents restored from the database carry no html — it lives in storage
  // and is only worth fetching once someone actually opens the result.
  const documentId = document?.documentId;
  const needsHtml = open && document?.status === "success" && !document.html;
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
  const issues = (document.errors ?? []).map(presentFinding);
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{document.name}</DialogTitle>
          <DialogDescription>
            Conversion result for this document.
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
          <p>
            <span className="font-semibold text-primary">
              Review your converted page
            </span>{" "}
            in Canvas before publishing. Compare it with your original document
            and work through the items below. Page numbers refer to the PDF used
            for conversion; the Canvas page does not have those page breaks.
            {/\.docx$/i.test(document.name) &&
              " The converted PDF may have different page breaks from Word."}
          </p>
        </div>

        {isError && document.errorMessage && (
          <p className="text-sm text-destructive">{document.errorMessage}</p>
        )}

        {isSuccess && !html && (
          <p className="text-sm text-muted-foreground">
            {isLoadingHtml
              ? "Loading converted HTML…"
              : "This online HTML copy is unavailable. Online documents expire after 14 days; re-upload the original to convert it again. Files downloaded to your computer are unaffected. If the online copy has not expired or been deleted, try again."}
          </p>
        )}

        {isSuccess && html && (
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
