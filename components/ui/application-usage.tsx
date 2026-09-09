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
            Convert PDFs into accessible Canvas content. For Word documents,
            export a PDF before uploading.
          </DialogDescription>
        </DialogHeader>
        <p className="font-medium">Follow the steps below to get started.</p>
        <ol className="list-inside list-decimal space-y-2 text-sm text-muted-foreground">
          <li>
            Export your Word document as PDF, then drop the PDF onto the upload
            area or click to browse. Each PDF can be up to 4 MB.
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
