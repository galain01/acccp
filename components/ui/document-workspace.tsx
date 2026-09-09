"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { deleteDocument } from "@/lib/actions/documents";
import { isPdfFilename } from "@/lib/document-input";
import type { UploadedDocument } from "@/lib/types/document";
import { Button } from "./button";
import DocumentTable from "./document-table";
import FileUpload from "./file-upload";

interface DocumentWorkspaceProps {
  sessionId: string;
  initialDocuments: UploadedDocument[];
}

export default function DocumentWorkspace({
  sessionId,
  initialDocuments,
}: DocumentWorkspaceProps): React.JSX.Element {
  const [documents, setDocuments] =
    useState<UploadedDocument[]>(initialDocuments);
  const abortControllersRef = useRef<Map<string, AbortController>>(new Map());

  const isProcessing = documents.some(
    (doc) => doc.status === "processing" || doc.status === "queued"
  );
  const hasDocuments = documents.length > 0;
  const canConvert =
    documents.some((doc) => !doc.locked && isPdfFilename(doc.name)) &&
    !isProcessing;
  const hasLegacyDocuments = documents.some((doc) => !isPdfFilename(doc.name));

  useEffect(() => {
    const controllers = abortControllersRef.current;
    return () => {
      controllers.forEach((controller) => controller.abort());
      controllers.clear();
    };
  }, []);

  const updateDocument = useCallback(
    (docId: string, patch: Partial<UploadedDocument>) => {
      setDocuments((prev) =>
        prev.map((doc) => (doc.id === docId ? { ...doc, ...patch } : doc))
      );
    },
    []
  );

  const addDocuments = useCallback((files: File[]) => {
    if (files.length === 0) return;
    setDocuments((prev) => [
      ...prev,
      ...files.map((file) => ({
        id: crypto.randomUUID(),
        name: file.name,
        size: file.size,
        uploadedAt: new Date(),
        status: "idle" as const,
        locked: false,
        file,
      })),
    ]);
  }, []);

  const toggleDocumentLock = useCallback((docId: string) => {
    setDocuments((prev) =>
      prev.map((doc) =>
        doc.id === docId ? { ...doc, locked: !doc.locked } : doc
      )
    );
  }, []);

  const handleDeleteDocument = useCallback(
    async (docId: string) => {
      abortControllersRef.current.get(docId)?.abort();
      abortControllersRef.current.delete(docId);

      const doc = documents.find((d) => d.id === docId);
      setDocuments((prev) => prev.filter((d) => d.id !== docId));

      if (doc?.documentId) await deleteDocument(doc.documentId);
    },
    [documents]
  );

  const convertDocument = useCallback(
    async (doc: UploadedDocument) => {
      if (!isPdfFilename(doc.name)) return;
      const form = new FormData();
      form.append("sessionId", sessionId);

      // A stored document is re-read from storage; a freshly picked one is sent.
      if (doc.documentId) form.append("documentId", doc.documentId);
      else if (doc.file) form.append("file", doc.file);
      else {
        updateDocument(doc.id, {
          status: "error",
          errorMessage: "This document is no longer available. Re-upload it.",
        });
        return;
      }

      const controller = new AbortController();
      abortControllersRef.current.set(doc.id, controller);
      updateDocument(doc.id, {
        status: "processing",
        html: undefined,
        errorMessage: undefined,
        errors: undefined,
      });

      try {
        const response = await fetch("/api/convert", {
          method: "POST",
          body: form,
          signal: controller.signal,
        });
        const data = await response.json();

        if (!response.ok) {
          updateDocument(doc.id, {
            status: "error",
            html: undefined,
            errorMessage: data.error ?? "Conversion failed.",
          });
          return;
        }

        updateDocument(doc.id, {
          status: "success",
          documentId: data.documentId,
          html: data.html,
          errorMessage: undefined,
          errors: data.errors,
        });
      } catch {
        // An abort means the user navigated away or removed the row.
        if (controller.signal.aborted) return;
        updateDocument(doc.id, {
          status: "error",
          html: undefined,
          errorMessage: "Conversion failed. Please try again.",
        });
      } finally {
        abortControllersRef.current.delete(doc.id);
      }
    },
    [sessionId, updateDocument]
  );

  const runConversion = useCallback(() => {
    const targets = documents.filter(
      (doc) => !doc.locked && isPdfFilename(doc.name)
    );
    if (targets.length === 0) return;

    targets.forEach((doc) => {
      abortControllersRef.current.get(doc.id)?.abort();
      updateDocument(doc.id, { status: "queued" });
    });
    targets.forEach((doc) => void convertDocument(doc));
  }, [documents, convertDocument, updateDocument]);

  return (
    <div className="mt-8 flex flex-col gap-6">
      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium text-foreground">
          Upload documents
        </h2>
        <FileUpload onFilesSelected={addDocuments} disabled={isProcessing} />
      </section>

      <section>
        <Button size="lg" disabled={!canConvert} onClick={runConversion}>
          Convert
        </Button>
        {!hasDocuments && (
          <p className="mt-2 text-sm text-muted-foreground">
            Upload at least one PDF to enable conversion.
          </p>
        )}
        {hasLegacyDocuments && (
          <p className="mt-2 text-sm text-muted-foreground">
            Previous Word conversions remain available. To convert one again,
            export it as PDF and upload the PDF. Only unlocked PDFs are
            converted.
          </p>
        )}
        {hasDocuments && isProcessing && (
          <p className="mt-2 text-sm text-muted-foreground">
            Conversion in progress…
          </p>
        )}
      </section>

      <DocumentTable
        documents={documents}
        onToggleLock={toggleDocumentLock}
        onDeleteDocument={handleDeleteDocument}
      />
    </div>
  );
}
