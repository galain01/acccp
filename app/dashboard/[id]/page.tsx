import ApplicationUsage from "@/components/ui/application-usage";
import DocumentWorkspace from "@/components/ui/document-workspace";
import { listDocuments } from "@/lib/actions/documents";

export default async function DashboardPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<React.JSX.Element> {
  const { id: sessionId } = await params;
  const documents = await listDocuments(sessionId);

  return (
    <main className="mx-auto my-8 md:mx-16 lg:mx-24">
      <div className="flex items-center justify-between gap-4">
        <h1 className="font-bold md:text-2xl">
          Document Accessibility Workspace
        </h1>
        <ApplicationUsage />
      </div>
      {/* Keyed so switching sessions resets the workspace rather than carrying
          the previous session's documents across. */}
      <DocumentWorkspace
        key={sessionId}
        sessionId={sessionId}
        initialDocuments={documents}
      />
    </main>
  );
}
