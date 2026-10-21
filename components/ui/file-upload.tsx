"use client";

import { useRef, useState, type DragEvent } from "react";
import { Upload } from "lucide-react";
import { cn } from "@/lib/utils";
import DocumentProcessingNotice from "./document-processing-notice";
import {
  isSupportedDocumentFilename,
  maxFileSizeForFilename,
} from "@/lib/document-input";

interface FileUploadProps {
  onFilesSelected: (files: File[]) => void;
  disabled?: boolean;
}

export default function FileUpload({
  onFilesSelected,
  disabled = false,
}: FileUploadProps): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [rejectHint, setRejectHint] = useState<string | null>(null);

  const handleFiles = (fileList: FileList | null) => {
    if (!fileList || disabled) return;

    const accepted = Array.from(fileList).filter(
      (file) =>
        isSupportedDocumentFilename(file.name) &&
        file.size > 0 &&
        file.size <= maxFileSizeForFilename(file.name)
    );
    const rejected = fileList.length - accepted.length;

    if (rejected > 0) {
      setRejectHint(
        `${rejected} file${rejected === 1 ? " was" : "s were"} not added. Choose Word (.docx) or PDF files up to 4 MB, or PowerPoint (.pptx) files up to 25 MB. Empty, older, and macro-enabled files are not supported.`
      );
    } else setRejectHint(null);

    if (accepted.length > 0) {
      onFilesSelected(accepted);
    }
  };

  const onDragOver = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (!disabled) setIsDragging(true);
  };

  const onDragLeave = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragging(false);
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragging(false);
    handleFiles(event.dataTransfer.files);
  };

  return (
    <div className="flex flex-col gap-2">
      <div
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-disabled={disabled}
        onKeyDown={(event) => {
          if (disabled) return;
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            inputRef.current?.click();
          }
        }}
        onClick={() => !disabled && inputRef.current?.click()}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        className={cn(
          "flex cursor-pointer flex-col items-center gap-2 rounded-2xl border border-dashed p-8 transition-colors",
          disabled && "pointer-events-none opacity-50",
          isDragging ? "border-primary bg-muted/50" : "hover:bg-muted"
        )}
      >
        <Upload className="size-8 text-muted-foreground" />
        <p className="text-sm font-medium">
          Drop Word, PDF, or PowerPoint files here or click to browse
        </p>
        <p className="text-xs text-muted-foreground">
          Mix file types in one upload. Word (.docx) and PDF: up to 4 MB and 60
          PDF pages. PowerPoint (.pptx): up to 25 MB and 60 slides.
        </p>
        <input
          ref={inputRef}
          type="file"
          accept=".pdf,.docx,.pptx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.presentationml.presentation"
          aria-label="Upload documents"
          multiple
          className="hidden"
          disabled={disabled}
          onChange={(event) => {
            handleFiles(event.target.files);
            event.target.value = "";
          }}
        />
      </div>
      <DocumentProcessingNotice compact outputTarget="mixed" />
      {rejectHint && (
        <p role="status" className="text-sm text-destructive">
          {rejectHint}
        </p>
      )}
    </div>
  );
}
