"use client";

import { useId } from "react";
import { Info } from "lucide-react";
import { cn } from "@/lib/utils";

export default function DocumentProcessingNotice({
  compact = false,
  className,
}: {
  compact?: boolean;
  className?: string;
}): React.JSX.Element {
  const headingId = useId();

  return (
    <aside
      aria-labelledby={headingId}
      className={cn("rounded-xl border bg-muted/50 p-4 text-sm", className)}
    >
      <h2 id={headingId} className="mb-2 flex items-center gap-2 font-medium">
        <Info className="size-4 shrink-0" aria-hidden="true" />
        Large scans may need smaller files
      </h2>
      <div className="space-y-2 leading-relaxed">
        {!compact && (
          <p>
            Upload Word or PDF files up to 4 MB and 60 PDF pages. Long scans and
            pages filled with color images may reach processing limits even when
            the file is small. Page count alone does not determine whether a
            file will work.
          </p>
        )}
        <p>
          Preparing PDF pages has a 90-second limit. AI conversion and review
          take additional time, so the whole process may take several minutes.
        </p>
        <p>
          If page preparation takes too long or exceeds a limit, that attempt
          stops with an error and no new HTML is generated. Split the document
          into shorter files or export with smaller images, then try again.
        </p>
      </div>
    </aside>
  );
}
