"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { deleteDocument } from "@/lib/actions/documents";
import {
  DEFAULT_OUTPUT_TARGET,
  isSupportedOutputForFilename,
  type OutputTarget,
} from "@/lib/output-formats";
import type { UploadedDocument } from "@/lib/types/document";
import { Button } from "./button";
import DocumentTable from "./document-table";
import FileUpload from "./file-upload";

interface DocumentWorkspaceProps {
  sessionId: string;
  initialDocuments: UploadedDocument[];
}

function isBatchTarget(doc: UploadedDocument): boolean {
  return (
    !doc.locked &&
    (doc.status === "idle" || doc.status === "error") &&
    isSupportedOutputForFilename(
      doc.name,
      doc.outputTarget ?? DEFAULT_OUTPUT_TARGET
    )
  );
}

export default function DocumentWorkspace({
  sessionId,
  initialDocuments,
}: DocumentWorkspaceProps): React.JSX.Element {
  const [documents, setDocuments] =
    useState<UploadedDocument[]>(initialDocuments);
  const [outputTarget, setOutputTarget] = useState<OutputTarget>(
    DEFAULT_OUTPUT_TARGET
  );
  const outputFormatId = useId();
  const abortControllersRef = useRef<Map<string, AbortController>>(new Map());

  const isProcessing = documents.some(
    (doc) => doc.status === "processing" || doc.status === "queued"
  );
  const hasDocuments = documents.length > 0;
  const canConvert = documents.some(isBatchTarget) && !isProcessing;
  const hasUnsupportedDocuments = documents.some(
    (doc) =>
      !isSupportedOutputForFilename(
        doc.name,
        doc.outputTarget ?? DEFAULT_OUTPUT_TARGET
      )
  );

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

  const addDocuments = useCallback(
    (files: File[]) => {
      const compatibleFiles = files.filter((file) =>
        isSupportedOutputForFilename(file.name, outputTarget)
      );
      if (compatibleFiles.length === 0) return;
      setDocuments((prev) => [
        ...prev,
        ...compatibleFiles.map((file) => ({
          id: crypto.randomUUID(),
          name: file.name,
          size: file.size,
          uploadedAt: new Date(),
          status: "idle" as const,
          locked: false,
          outputTarget,
          file,
        })),
      ]);
    },
    [outputTarget]
  );

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
      if (
        !isSupportedOutputForFilename(
          doc.name,
          doc.outputTarget ?? DEFAULT_OUTPUT_TARGET
        ) ||
        abortControllersRef.current.has(doc.id)
      )
        return;
      const form = new FormData();
      form.append("sessionId", sessionId);
      form.append("outputTarget", doc.outputTarget ?? DEFAULT_OUTPUT_TARGET);

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
        changes: undefined,
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
            // A failed model call may already have saved the source. Retrying
            // must reuse that document instead of uploading a duplicate.
            ...(typeof data.documentId === "string"
              ? { documentId: data.documentId }
              : {}),
            html: undefined,
            errorMessage:
              typeof data.detail === "string" && data.detail.trim()
                ? data.detail
                : typeof data.error === "string"
                  ? data.error
                  : "Conversion failed.",
          });
          return;
        }

        updateDocument(doc.id, {
          status: "success",
          documentId: data.documentId,
          jobId: data.jobId,
          html: doc.outputTarget === "accessible_pptx" ? undefined : data.html,
          changes: data.changes,
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
    // The ref also catches a second click before React renders disabled buttons.
    if (isProcessing || abortControllersRef.current.size > 0) return;
    const targets = documents.filter(isBatchTarget);
    if (targets.length === 0) return;

    targets.forEach((doc) => {
      updateDocument(doc.id, { status: "queued" });
    });
    targets.forEach((doc) => void convertDocument(doc));
  }, [documents, isProcessing, convertDocument, updateDocument]);

  const reconvertDocument = useCallback(
    (docId: string) => {
      if (isProcessing || abortControllersRef.current.size > 0) return;
      const doc = documents.find((document) => document.id === docId);
      if (!doc || doc.locked || doc.status !== "success") return;
      void convertDocument(doc);
    },
    [documents, isProcessing, convertDocument]
  );

  return (
    <div className="mt-8 flex flex-col gap-6">
      <section className="flex flex-col gap-2">
        <label
          htmlFor={outputFormatId}
          className="text-sm font-medium text-foreground"
        >
          Output format
        </label>
        <select
          id={outputFormatId}
          value={outputTarget}
          disabled={isProcessing}
          aria-describedby={`${outputFormatId}-description`}
          onChange={(event) =>
            setOutputTarget(event.target.value as OutputTarget)
          }
          className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50 sm:max-w-sm"
        >
          <option value="canvas_html">Canvas HTML</option>
          <option value="accessible_pptx">PowerPoint (.pptx)</option>
        </select>
        <p
          id={`${outputFormatId}-description`}
          className="text-sm text-muted-foreground"
        >
          {outputTarget === "accessible_pptx"
            ? "Upload a PowerPoint (.pptx) to improve its accessibility and download an updated PowerPoint file."
            : "Upload a Word (.docx) document or PDF to create HTML for Canvas."}
          {hasDocuments &&
            " This choice applies to new uploads. Documents already listed keep their output format."}
        </p>
        <h2 className="text-sm font-medium text-foreground">
          Upload documents
        </h2>
        <FileUpload
          key={outputTarget}
          outputTarget={outputTarget}
          onFilesSelected={addDocuments}
          disabled={isProcessing}
        />
        <p className="text-sm text-muted-foreground">
          Download the results you want to keep. Online copies of originals and
          converted files expire 14 days after the document is first saved for
          conversion. Re-converting does not extend this period. Expired online
          copies become unavailable and are queued for daily cleanup. Files on
          your computer are unaffected.
        </p>
      </section>

      <section>
        <Button size="lg" disabled={!canConvert} onClick={runConversion}>
          Convert
        </Button>
        {!hasDocuments && (
          <p className="mt-2 text-sm text-muted-foreground">
            Upload at least one file for your selected output format to enable
            conversion.
          </p>
        )}
        {hasDocuments && !isProcessing && (
          <p className="mt-2 text-sm text-muted-foreground">
            Convert processes only new or failed documents that are unlocked.
            Completed documents are skipped. Use Re-convert on a completed
            document to generate a new result and use additional model tokens.
          </p>
        )}
        {hasUnsupportedDocuments && (
          <p className="mt-2 text-sm text-muted-foreground">
            Previous conversions remain available until they expire. Canvas HTML
            accepts PDF and .docx files; PowerPoint output accepts .pptx files.
            Save older .doc or .ppt files in the newer format before uploading.
          </p>
        )}
        {hasDocuments && isProcessing && (
          <p className="mt-2 text-sm text-muted-foreground">
            Conversion in progress… Each document uses the output format shown
            in its row. This may take several minutes.
          </p>
        )}
      </section>

      <DocumentTable
        documents={documents}
        onToggleLock={toggleDocumentLock}
        onDeleteDocument={handleDeleteDocument}
        onReconvert={reconvertDocument}
        isProcessing={isProcessing}
      />
    </div>
  );
}
