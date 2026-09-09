"use client";

import { Info } from "lucide-react";
import { useEffect, useState } from "react";
import { getDocumentHtml } from "@/lib/actions/documents";
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
  const issues = document.errors ?? [];
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
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{document.name}</DialogTitle>
          <DialogDescription>
            Conversion result for this document.
          </DialogDescription>
          {(errorCount > 0 || warningCount > 0) && (
            <div className="flex flex-wrap gap-1">
              {errorCount > 0 && (
                <Badge variant="destructive">
                  {errorCount} {errorCount === 1 ? "error" : "errors"}
                </Badge>
              )}
              {warningCount > 0 && (
                <Badge variant="warning">
                  {warningCount} {warningCount === 1 ? "warning" : "warnings"}
                </Badge>
              )}
            </div>
          )}
        </DialogHeader>

        <div className="flex items-start gap-2 rounded-2xl border border-primary/30 bg-primary/5 p-3 text-sm">
          <Info className="mt-0.5 size-4 shrink-0 text-primary" />
          <p>
            <span className="font-semibold text-primary">
              HTML output should be reviewed
            </span>{" "}
            before pasting into Canvas. Verify headings, links, tables, and
            accessibility before publishing.
          </p>
        </div>

        {isError && document.errorMessage && (
          <p className="text-sm text-destructive">{document.errorMessage}</p>
        )}

        {isSuccess && !html && (
          <p className="text-sm text-muted-foreground">
            {isLoadingHtml
              ? "Loading converted HTML…"
              : "The converted HTML for this document could not be loaded."}
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
              {issues.length > 0 && (
                <AccordionItem value="issues">
                  <AccordionTrigger>
                    View accessibility issues ({issues.length})
                  </AccordionTrigger>
                  <AccordionContent>
                    <ul className="flex max-h-64 flex-col gap-3 overflow-auto">
                      {issues.map((issue, index) => (
                        <li
                          key={index}
                          className="rounded-xl border border-border p-3 text-sm"
                        >
                          <div className="flex flex-wrap items-center gap-2">
                            <Badge
                              variant={
                                issue.severity === "error"
                                  ? "destructive"
                                  : "warning"
                              }
                            >
                              {issue.severity}
                            </Badge>
                            <span className="font-medium">
                              {formatIssueType(issue.type)}
                            </span>
                            {issue.wcag && (
                              <span className="text-xs text-muted-foreground">
                                {issue.wcag}
                              </span>
                            )}
                          </div>
                          <p className="mt-1">{issue.message}</p>
                          {issue.element && (
                            <code className="mt-1 block overflow-auto rounded bg-muted px-2 py-1 text-xs">
                              {issue.element}
                            </code>
                          )}
                          {issue.suggestion && (
                            <p className="mt-1 text-muted-foreground">
                              {issue.suggestion}
                            </p>
                          )}
                        </li>
                      ))}
                    </ul>
                  </AccordionContent>
                </AccordionItem>
              )}

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
      </DialogContent>
    </Dialog>
  );
}
