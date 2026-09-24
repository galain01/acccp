import { Button } from "./button";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "./dialog";

export default function ApplicationUsage(): React.JSX.Element {
  return (
    <Dialog>
      <DialogTrigger render={<Button size="lg" />}>Usage</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Usage</DialogTitle>
          <DialogDescription>
            Create Canvas HTML or improve the accessibility of a PowerPoint
            file.
          </DialogDescription>
        </DialogHeader>
        <p className="font-medium">Follow the steps below to get started.</p>
        <ol className="list-inside list-decimal space-y-2 text-sm text-muted-foreground">
          <li>
            Choose your output format. Canvas HTML accepts Word (.docx)
            documents and PDFs; PowerPoint output accepts PowerPoint (.pptx)
            files. Drop files onto the upload area or click to browse. Each file
            can be up to 4 MB.
          </li>
          <li>
            Click{" "}
            <strong className="font-medium text-foreground">Convert</strong> to
            start the conversion process.
          </li>
          <li>
            Once processing completes, click a document name to download the
            result and read the review items. Canvas HTML also offers a copy
            option.
          </li>
          <li>
            For Canvas, review the findings and re-add any image placeholders
            before publishing. For PowerPoint, review the changes and remaining
            items, then run PowerPoint’s Accessibility Checker before sharing.
          </li>
        </ol>
      </DialogContent>
    </Dialog>
  );
}
