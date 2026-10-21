"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { deleteDocument } from "@/lib/actions/documents";
import {
  isPptxFilename,
  isSupportedDocumentFilename,
  maxFileSizeForFilename,
} from "@/lib/document-input";
import {
  DocumentUploadError,
  uploadPowerPointDocument,
} from "@/lib/document-upload-client";
import {
  canChooseDocumentOutput,
  getDocumentOutputChoice,
  getOutputChoice,
  isOutputIntent,
  type OutputIntent,
} from "@/lib/output-intent";
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
    Boolean(getDocumentOutputChoice(doc).target)
  );
}

export default function DocumentWorkspace({
  sessionId,
  initialDocuments,
}: DocumentWorkspaceProps): React.JSX.Element {
  const [documents, setDocuments] =
    useState<UploadedDocument[]>(initialDocuments);
  const [outputIntent, setOutputIntent] = useState<OutputIntent>("original");
  const outputFormatId = useId();
  const abortControllersRef = useRef<Map<string, AbortController>>(new Map());
  const mountedRef = useRef(false);
  const batchActiveRef = useRef(false);
  const deletedRowsRef = useRef(new Set<string>());
  const reservedIdsRef = useRef(new Map<string, string>());
  const uploadedIdsRef = useRef(new Map<string, string>());
  const deleteRequestsRef = useRef(new Map<string, Promise<void>>());

  const isProcessing = documents.some(
    (doc) => doc.status === "processing" || doc.status === "queued"
  );
  const hasDocuments = documents.length > 0;
  const readyCount = documents.filter(isBatchTarget).length;
  const canConvert = readyCount > 0 && !isProcessing;
  const unavailableCount = documents.filter(
    (doc) => !getDocumentOutputChoice(doc).target
  ).length;
  const editableCount = documents.filter(canChooseDocumentOutput).length;

  useEffect(() => {
    mountedRef.current = true;
    const controllers = abortControllersRef.current;
    return () => {
      mountedRef.current = false;
      controllers.forEach((controller) => controller.abort());
      controllers.clear();
    };
  }, []);

  const updateDocument = useCallback(
    (docId: string, patch: Partial<UploadedDocument>) => {
      if (!mountedRef.current || deletedRowsRef.current.has(docId)) return;
      setDocuments((prev) =>
        prev.map((doc) => (doc.id === docId ? { ...doc, ...patch } : doc))
      );
    },
    []
  );

  const addDocuments = useCallback(
    (files: File[]) => {
      const compatibleFiles = files.filter(
        (file) =>
          isSupportedDocumentFilename(file.name) &&
          file.size > 0 &&
          file.size <= maxFileSizeForFilename(file.name)
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
          outputIntent,
          outputTarget: getOutputChoice(file.name, outputIntent).target,
          file,
        })),
      ]);
    },
    [outputIntent]
  );

  const changeOutput = useCallback(
    (intent: OutputIntent, docId?: string) => {
      if (
        isProcessing ||
        batchActiveRef.current ||
        abortControllersRef.current.size > 0
      )
        return;
      setDocuments((prev) =>
        prev.map((doc) =>
          (!docId || doc.id === docId) && canChooseDocumentOutput(doc)
            ? {
                ...doc,
                outputIntent: intent,
                outputTarget: getOutputChoice(doc.name, intent).target,
              }
            : doc
        )
      );
    },
    [isProcessing]
  );

  const toggleDocumentLock = useCallback((docId: string) => {
    setDocuments((prev) =>
      prev.map((doc) =>
        doc.id === docId ? { ...doc, locked: !doc.locked } : doc
      )
    );
  }, []);

  const removeStoredDocument = useCallback((documentId: string) => {
    const existing = deleteRequestsRef.current.get(documentId);
    if (existing) return existing;
    const request = deleteDocument(documentId).then(
      () => {},
      () => {
        // The server keeps failed cleanup discoverable for its retention worker.
        deleteRequestsRef.current.delete(documentId);
      }
    );
    deleteRequestsRef.current.set(documentId, request);
    return request;
  }, []);

  const handleDeleteDocument = useCallback(
    async (docId: string) => {
      deletedRowsRef.current.add(docId);
      abortControllersRef.current.get(docId)?.abort();

      const doc = documents.find((d) => d.id === docId);
      setDocuments((prev) => prev.filter((d) => d.id !== docId));

      const documentId =
        doc?.documentId ??
        reservedIdsRef.current.get(docId) ??
        uploadedIdsRef.current.get(docId);
      uploadedIdsRef.current.delete(docId);
      if (documentId) await removeStoredDocument(documentId);
    },
    [documents, removeStoredDocument]
  );

  const convertDocument = useCallback(
    async (doc: UploadedDocument) => {
      const target = getDocumentOutputChoice(doc).target;
      if (
        !target ||
        abortControllersRef.current.has(doc.id) ||
        deletedRowsRef.current.has(doc.id) ||
        !mountedRef.current
      )
        return;
      let documentId = doc.documentId ?? uploadedIdsRef.current.get(doc.id);
      if (!documentId && !doc.file) {
        updateDocument(doc.id, {
          status: "error",
          errorMessage: "This document is no longer available. Re-upload it.",
        });
        return;
      }

      const controller = new AbortController();
      abortControllersRef.current.set(doc.id, controller);
      let reservationId: string | undefined;
      let uploadComplete = false;
      let uploading = !documentId && isPptxFilename(doc.name);
      updateDocument(doc.id, {
        status: "processing",
        processingPhase: uploading ? "uploading" : undefined,
        html: undefined,
        errorMessage: undefined,
        errors: undefined,
        changes: undefined,
      });

      try {
        if (uploading) {
          documentId = await uploadPowerPointDocument({
            file: doc.file!,
            sessionId,
            signal: controller.signal,
            onReserved: (id) => {
              reservationId = id;
              reservedIdsRef.current.set(doc.id, id);
            },
          });
          uploadComplete = true;
          uploadedIdsRef.current.set(doc.id, documentId);
          // Remember the completed source before starting a possibly failing
          // model request. Retrying must not reserve or upload it again.
          updateDocument(doc.id, { documentId, processingPhase: undefined });
          if (controller.signal.aborted) {
            if (deletedRowsRef.current.has(doc.id))
              await removeStoredDocument(documentId);
            return;
          }
          uploading = false;
        }
        if (
          controller.signal.aborted ||
          !mountedRef.current ||
          deletedRowsRef.current.has(doc.id)
        )
          return;
        const form = new FormData();
        form.append("sessionId", sessionId);
        form.append("outputTarget", target);
        if (documentId) form.append("documentId", documentId);
        else form.append("file", doc.file!);
        const response = await fetch("/api/convert", {
          method: "POST",
          body: form,
          signal: controller.signal,
        });
        const data = await response.json();
        if (typeof data.documentId === "string") {
          documentId = data.documentId;
          uploadedIdsRef.current.set(doc.id, data.documentId);
        }
        if (
          controller.signal.aborted ||
          !mountedRef.current ||
          deletedRowsRef.current.has(doc.id)
        ) {
          if (documentId && deletedRowsRef.current.has(doc.id))
            await removeStoredDocument(documentId);
          return;
        }

        if (!response.ok) {
          updateDocument(doc.id, {
            status: "error",
            processingPhase: undefined,
            // A failed model call may already have saved the source. Retrying
            // must reuse that document instead of uploading a duplicate.
            ...(documentId ? { documentId } : {}),
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
          processingPhase: undefined,
          documentId,
          jobId: data.jobId,
          html: target === "canvas_html" ? data.html : undefined,
          changes: data.changes,
          errorMessage: undefined,
          errors: data.errors,
        });
      } catch (error) {
        if (reservationId && !uploadComplete) {
          await removeStoredDocument(reservationId);
          reservedIdsRef.current.delete(doc.id);
          updateDocument(doc.id, { documentId: undefined });
        }
        // An abort means the user navigated away or removed the row.
        if (controller.signal.aborted) return;
        updateDocument(doc.id, {
          status: "error",
          processingPhase: undefined,
          html: undefined,
          errorMessage:
            error instanceof DocumentUploadError
              ? error.message
              : uploading
                ? "The PowerPoint upload did not finish. Please try again."
                : "Conversion failed. Please try again.",
        });
      } finally {
        abortControllersRef.current.delete(doc.id);
      }
    },
    [sessionId, updateDocument, removeStoredDocument]
  );

  const runConversion = useCallback(() => {
    // The ref also catches a second click before React renders disabled buttons.
    if (
      isProcessing ||
      batchActiveRef.current ||
      abortControllersRef.current.size > 0
    )
      return;
    const targets = documents.filter(isBatchTarget);
    if (targets.length === 0) return;

    targets.forEach((doc) => {
      updateDocument(doc.id, { status: "queued" });
    });
    batchActiveRef.current = true;
    void (async () => {
      try {
        for (const doc of targets) {
          if (!mountedRef.current) break;
          if (!deletedRowsRef.current.has(doc.id)) await convertDocument(doc);
        }
      } finally {
        batchActiveRef.current = false;
      }
    })();
  }, [documents, isProcessing, convertDocument, updateDocument]);

  const reconvertDocument = useCallback(
    (docId: string) => {
      if (
        isProcessing ||
        batchActiveRef.current ||
        abortControllersRef.current.size > 0
      )
        return;
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
          Default for new uploads
        </label>
        <select
          id={outputFormatId}
          value={outputIntent}
          disabled={isProcessing}
          aria-describedby={`${outputFormatId}-description`}
          onChange={(event) => {
            if (isOutputIntent(event.target.value))
              setOutputIntent(event.target.value);
          }}
          className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50 sm:max-w-sm"
        >
          <option value="original">Keep original format</option>
          <option value="html">HTML (Canvas)</option>
        </select>
        <p
          id={`${outputFormatId}-description`}
          className="text-sm text-muted-foreground"
        >
          Choose a format for new files, then adjust individual files below.
          Keep Word, PDF, and PowerPoint documents in their original format with
          accessibility improvements. Word and PDF can also become HTML.
          PowerPoint to HTML is not available yet.
        </p>
        {hasDocuments && (
          <div>
            <Button
              variant="outline"
              size="sm"
              disabled={isProcessing || editableCount === 0}
              onClick={() => changeOutput(outputIntent)}
            >
              Apply to pending files ({editableCount})
            </Button>
            <p className="mt-1 text-xs text-muted-foreground">
              Applies to unlocked files that have not started processing. Saved
              results and attempted files keep their output format.
            </p>
          </div>
        )}
        <h2 className="text-sm font-medium text-foreground">
          Upload documents
        </h2>
        <FileUpload onFilesSelected={addDocuments} disabled={isProcessing} />
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
          Improve accessibility
        </Button>
        {!hasDocuments && (
          <p className="mt-2 text-sm text-muted-foreground">
            Add files and choose an available output format to start.
          </p>
        )}
        {hasDocuments && !isProcessing && (
          <p className="mt-2 text-sm text-muted-foreground">
            {readyCount} file{readyCount === 1 ? " is" : "s are"} ready to
            process. Only new or failed documents that are unlocked are
            processed. Completed documents are skipped. Use Re-convert on a
            completed document to generate a new result and use additional model
            tokens.
          </p>
        )}
        {unavailableCount > 0 && (
          <p role="status" className="mt-2 text-sm text-muted-foreground">
            {unavailableCount} file{unavailableCount === 1 ? " has" : "s have"}{" "}
            an unavailable output format and will not be processed. Choose an
            available format for each pending file, or remove it. Pending files
            stay in this browser until processing starts and are lost if you
            reload or leave this page. Your original files are unchanged.
          </p>
        )}
        {hasDocuments && isProcessing && (
          <p className="mt-2 text-sm text-muted-foreground">
            Documents are processed one at a time in this browser. Keep this
            page open while they upload and convert. This may take several
            minutes.
          </p>
        )}
      </section>

      <DocumentTable
        documents={documents}
        onToggleLock={toggleDocumentLock}
        onDeleteDocument={handleDeleteDocument}
        onReconvert={reconvertDocument}
        isProcessing={isProcessing}
        onChangeOutput={(docId, intent) => changeOutput(intent, docId)}
        onReviewExport={(docId, result) =>
          updateDocument(docId, {
            errors: result.findings,
            changes: result.changes,
          })
        }
      />
    </div>
  );
}
