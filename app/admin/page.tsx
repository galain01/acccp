import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import AdminMetrics from "@/components/ui/admin-metrics";
import { Button } from "@/components/ui/button";
import PendingUsersTable from "@/components/ui/pending-users-table";
import { listPendingUsersPage } from "@/lib/actions/admin-metrics";
import { verifyRoleOrRedirect } from "@/lib/auth";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { metricsRange } from "@/lib/metrics-display";

function parsePage(value: string | string[] | undefined): number {
  const raw = Array.isArray(value) ? value[0] : value;
  const parsed = raw ? Number.parseInt(raw, 10) : 1;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

interface AdminPageProps {
  searchParams: Promise<{
    usersPage?: string;
    jobsPage?: string;
    range?: string;
    from?: string;
    to?: string;
  }>;
}

export default async function AdminPage({
  searchParams,
}: AdminPageProps): Promise<React.JSX.Element> {
  await verifyRoleOrRedirect(["admin"]);

  const params = await searchParams;
  const usersPage = parsePage(params.usersPage);
  const jobsPage = parsePage(params.jobsPage);
  const range = metricsRange(params);

  const pendingUsers = await listPendingUsersPage(usersPage);

  // Pagination is URL-driven (?usersPage=/?jobsPage=), which reloads the page
  // and would otherwise always reset the Tabs to the first tab. Seed the
  // uncontrolled Tabs' initial tab from whichever page param is present so
  // paginating the Metrics table doesn't kick the admin back to Users.
  const defaultTab = params.jobsPage || params.range ? "metrics" : "users";

  return (
    <main className="flex min-h-full flex-col items-center gap-6 px-4 py-12">
      <div className="flex w-full max-w-6xl flex-col gap-6">
        <Button
          render={
            <Link href="/dashboard">
              <ArrowLeft />
              Back to Dashboard
            </Link>
          }
          variant="outline"
          size="sm"
          className="self-start"
        />
        <Tabs key={defaultTab} defaultValue={defaultTab} className="w-full">
          <TabsList>
            <TabsTrigger value="users">Users</TabsTrigger>
            <TabsTrigger value="metrics">Metrics</TabsTrigger>
          </TabsList>
          <TabsContent value="users">
            <PendingUsersTable
              key={pendingUsers.page}
              users={pendingUsers.rows}
              page={pendingUsers.page}
              totalPages={pendingUsers.totalPages}
            />
          </TabsContent>
          <TabsContent value="metrics">
            <AdminMetrics jobsPage={jobsPage} range={range} />
          </TabsContent>
        </Tabs>
      </div>
    </main>
  );
}
