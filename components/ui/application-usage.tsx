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
            Convert Word documents and PDFs into accessible Canvas content.
          </DialogDescription>
        </DialogHeader>
        <p className="font-medium">Follow the steps below to get started.</p>
        <ol className="list-inside list-decimal space-y-2 text-sm text-muted-foreground">
          <li>
            Drop your Word (.docx) document or PDF onto the upload area or click
            to browse. Each file can be up to 4 MB. Word documents are converted
            to PDF automatically.
          </li>
          <li>
            Click{" "}
            <strong className="font-medium text-foreground">Convert</strong> to
            start the conversion process.
          </li>
          <li>
            Once conversion completes, click a document name to view, copy, and
            download the converted HTML output.
          </li>
          <li>
            Review the accessibility findings and re-add any image placeholders
            in Canvas before publishing.
          </li>
        </ol>
      </DialogContent>
    </Dialog>
  );
}
