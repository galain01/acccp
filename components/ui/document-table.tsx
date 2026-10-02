"use client";

import { Lock, LockOpen, X } from "lucide-react";
import { useState } from "react";
import {
  DEFAULT_OUTPUT_TARGET,
  isSupportedOutputForFilename,
} from "@/lib/output-formats";
import { formatBytes, formatUploadTime } from "@/lib/format";
import type { ConversionStatus, UploadedDocument } from "@/lib/types/document";
import type { PowerPointReviewExport } from "@/lib/powerpoint-review-contract";
import { Badge } from "./badge";
import { Button } from "./button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "./card";
import ConversionResultDialog from "./conversion-result-dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "./table";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip";

interface DocumentTableProps {
  documents: UploadedDocument[];
  onToggleLock: (docId: string) => void;
  onDeleteDocument: (docId: string) => void | Promise<void>;
  onReconvert: (docId: string) => void;
  isProcessing: boolean;
  onReviewExport?: (documentId: string, result: PowerPointReviewExport) => void;
}

function statusBadge(
  status: ConversionStatus,
  isPowerPoint = false,
  hasAccessibilityErrors = false,
  uploading = false
): React.JSX.Element {
  switch (status) {
    case "idle":
      return <Badge variant="outline">Ready</Badge>;
    case "queued":
      return <Badge variant="secondary">Queued</Badge>;
    case "processing":
      return (
        <Badge variant="processing">
          {uploading ? "Uploading" : "Processing"}
        </Badge>
      );
    case "success":
      if (isPowerPoint) {
        return (
          <Badge variant={hasAccessibilityErrors ? "destructive" : "secondary"}>
            {hasAccessibilityErrors ? "Needs a fix" : "Ready to review"}
          </Badge>
        );
      }
      return (
        <Badge className="bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
          Success
        </Badge>
      );
    case "error":
      return <Badge variant="destructive">Error</Badge>;
  }
}

function issueBadges(doc: UploadedDocument): React.JSX.Element | null {
  if (!doc.errors || doc.errors.length === 0) return null;
  const errorCount = doc.errors.filter((e) => e.severity === "error").length;
  const warningCount = doc.errors.filter(
    (e) => e.severity === "warning"
  ).length;

  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {errorCount > 0 && (
        <Badge variant="destructive">Needs a fix: {errorCount}</Badge>
      )}
      {warningCount > 0 && (
        <Badge variant="warning">Please check: {warningCount}</Badge>
      )}
    </div>
  );
}

export default function DocumentTable({
  documents,
  onToggleLock,
  onDeleteDocument,
  onReconvert,
  isProcessing,
  onReviewExport,
}: DocumentTableProps): React.JSX.Element {
  const [selectedDocument, setSelectedDocument] =
    useState<UploadedDocument | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [resultViewId, setResultViewId] = useState(0);

  const openResult = (doc: UploadedDocument) => {
    if (doc.status !== "success" && doc.status !== "error") return;
    setSelectedDocument(doc);
    setResultViewId((value) => value + 1);
    setDialogOpen(true);
  };

  const handleDelete = (doc: UploadedDocument) => {
    if (selectedDocument?.id === doc.id) {
      setDialogOpen(false);
      setSelectedDocument(null);
    }
    onDeleteDocument(doc.id);
  };

  if (documents.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Documents</CardTitle>
          <CardDescription>No saved documents available</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Choose an output format, then drag the matching files onto the
            upload area above or click to browse, then click{" "}
            <strong className="font-medium text-foreground">Convert</strong> to
            start the conversion process.
          </p>
          <p className="mt-2 text-sm text-muted-foreground">
            Documents saved online expire after 14 days and disappear from this
            list when it reloads. Files you downloaded to your computer are
            unaffected.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Documents</CardTitle>
          <CardDescription>
            {documents.length} document{documents.length === 1 ? "" : "s"} in
            this session
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">
                  <span className="sr-only">Conversion lock</span>
                </TableHead>
                <TableHead>Document name</TableHead>
                <TableHead>Output format</TableHead>
                <TableHead>Conversion status</TableHead>
                <TableHead>File size</TableHead>
                <TableHead>Upload time</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {documents.map((doc) => {
                const canOpenResult =
                  doc.status === "success" || doc.status === "error";
                const canReconvert =
                  doc.status === "success" &&
                  isSupportedOutputForFilename(
                    doc.name,
                    doc.outputTarget ?? DEFAULT_OUTPUT_TARGET
                  );

                return (
                  <TableRow key={doc.id}>
                    <TableCell>
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              aria-label={
                                doc.locked
                                  ? `Unlock ${doc.name}`
                                  : `Lock ${doc.name}`
                              }
                              disabled={isProcessing}
                              onClick={() => onToggleLock(doc.id)}
                            />
                          }
                        >
                          {doc.locked ? (
                            <Lock className="size-4" />
                          ) : (
                            <LockOpen className="size-4 text-muted-foreground" />
                          )}
                        </TooltipTrigger>
                        <TooltipContent>
                          {doc.locked
                            ? "Locked: skipped during conversion. Unlock to allow conversion."
                            : "Lock to skip this document during conversion."}
                        </TooltipContent>
                      </Tooltip>
                    </TableCell>
                    <TableCell className="max-w-[200px] truncate">
                      {canOpenResult ? (
                        <button
                          type="button"
                          onClick={() => openResult(doc)}
                          className="truncate text-left font-medium text-primary underline-offset-4 hover:underline"
                        >
                          {doc.name}
                        </button>
                      ) : (
                        <span className="truncate">{doc.name}</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {doc.outputTarget === "accessible_pptx"
                        ? "PowerPoint (.pptx)"
                        : "Canvas HTML"}
                    </TableCell>
                    <TableCell>
                      {statusBadge(
                        doc.status,
                        doc.outputTarget === "accessible_pptx",
                        doc.errors?.some((issue) => issue.severity === "error"),
                        doc.processingPhase === "uploading"
                      )}
                      {issueBadges(doc)}
                    </TableCell>
                    <TableCell>{formatBytes(doc.size)}</TableCell>
                    <TableCell>{formatUploadTime(doc.uploadedAt)}</TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        {canReconvert && (
                          <Tooltip>
                            <TooltipTrigger
                              render={
                                <Button
                                  variant="outline"
                                  size="sm"
                                  aria-label={`Re-convert ${doc.name}`}
                                  disabled={doc.locked || isProcessing}
                                  focusableWhenDisabled
                                  className="aria-disabled:opacity-50"
                                  onClick={() => onReconvert(doc.id)}
                                />
                              }
                            >
                              Re-convert
                            </TooltipTrigger>
                            <TooltipContent>
                              {doc.locked
                                ? "Unlock this document to re-convert it."
                                : isProcessing
                                  ? "Wait for the current conversion to finish."
                                  : "Convert this document again and replace its previous result."}
                            </TooltipContent>
                          </Tooltip>
                        )}
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                aria-label={`Remove ${doc.name}`}
                                className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                                onClick={() => handleDelete(doc)}
                              />
                            }
                          >
                            <X className="size-4" />
                          </TooltipTrigger>
                          <TooltipContent>Remove document</TooltipContent>
                        </Tooltip>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Keyed to the conversion so a different result cannot reuse review choices. */}
      <ConversionResultDialog
        key={`${selectedDocument?.id}:${selectedDocument?.jobId ?? ""}:${resultViewId}`}
        document={selectedDocument}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onReviewExport={(result) => {
          if (!selectedDocument) return;
          setSelectedDocument({
            ...selectedDocument,
            errors: result.findings,
            changes: result.changes,
          });
          onReviewExport?.(selectedDocument.id, result);
        }}
      />
    </>
  );
}
