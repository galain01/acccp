"use client";

import { Lock, LockOpen, X } from "lucide-react";
import { useState } from "react";
import { formatBytes, formatUploadTime } from "@/lib/format";
import type { ConversionStatus, UploadedDocument } from "@/lib/types/document";
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
}

function statusBadge(status: ConversionStatus): React.JSX.Element {
  switch (status) {
    case "idle":
      return <Badge variant="outline">Ready</Badge>;
    case "queued":
      return <Badge variant="secondary">Queued</Badge>;
    case "processing":
      return <Badge variant="processing">Processing</Badge>;
    case "success":
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
  );
}

export default function DocumentTable({
  documents,
  onToggleLock,
  onDeleteDocument,
}: DocumentTableProps): React.JSX.Element {
  const [selectedDocument, setSelectedDocument] =
    useState<UploadedDocument | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  const openResult = (doc: UploadedDocument) => {
    if (doc.status !== "success" && doc.status !== "error") return;
    setSelectedDocument(doc);
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
            Drag Word or PDF files onto the upload area above or click to
            browse, then click{" "}
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
                <TableHead className="w-10" />
                <TableHead>Document name</TableHead>
                <TableHead>Conversion status</TableHead>
                <TableHead>File size</TableHead>
                <TableHead>Upload time</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {documents.map((doc) => {
                const canOpenResult =
                  doc.status === "success" || doc.status === "error";

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
                                  ? "Unlock document for re-conversion"
                                  : "Lock document to prevent re-conversion"
                              }
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
                            ? "Locked — skipped on re-convert"
                            : "Prevent re-conversion"}
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
                      {statusBadge(doc.status)}
                      {issueBadges(doc)}
                    </TableCell>
                    <TableCell>{formatBytes(doc.size)}</TableCell>
                    <TableCell>{formatUploadTime(doc.uploadedAt)}</TableCell>
                    <TableCell>
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
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Keyed so the fetched html resets when a different document is opened. */}
      <ConversionResultDialog
        key={selectedDocument?.id}
        document={selectedDocument}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
      />
    </>
  );
}
