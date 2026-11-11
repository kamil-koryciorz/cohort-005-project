import { useEffect } from "react";
import { data, isRouteErrorResponse, Link, useFetcher } from "react-router";
import { toast } from "sonner";
import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import { AlertTriangle, Undo2 } from "lucide-react";
import type { Route } from "./+types/admin.refund-requests";
import { db } from "~/db";
import {
  courses,
  purchases,
  refunds,
  RefundStatus,
  UserRole,
  users,
} from "~/db/schema";
import { requireUserId } from "~/lib/access.server";
import { parseFormData } from "~/lib/validation";
import { formatPrice } from "~/lib/utils";
import {
  approveRefundRequest,
  buildRefundRequestDecidedEmail,
  declineRefundRequest,
  RefundRequestError,
  sendEmail,
} from "~/lib/refunds.server";
import { Card, CardContent } from "~/components/ui/card";
import { Button } from "~/components/ui/button";

const decisionSchema = z.object({
  intent: z.enum(["approve", "decline"]),
  refundRequestId: z.coerce.number().int(),
});

async function requireAdmin(request: Request) {
  const userId = await requireUserId(request);
  const user = db.select().from(users).where(eq(users.id, userId)).get();

  if (!user || user.role !== UserRole.Admin) {
    throw data("Only admins can review Refund Requests.", { status: 403 });
  }

  return userId;
}

export function meta() {
  return [
    { title: "Refund Requests — Cadence" },
    { name: "description", content: "Approve or decline Refund Requests" },
  ];
}

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdmin(request);

  const pendingRefundRequests = db
    .select({
      id: refunds.id,
      learnerName: users.name,
      learnerEmail: users.email,
      courseTitle: courses.title,
      courseSlug: courses.slug,
      refundAmount: purchases.amountPaid,
      reason: refunds.reason,
      requestedAt: refunds.requestedAt,
    })
    .from(refunds)
    .innerJoin(purchases, eq(refunds.purchaseId, purchases.id))
    .innerJoin(users, eq(purchases.userId, users.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(eq(refunds.status, RefundStatus.Pending))
    .orderBy(desc(refunds.requestedAt))
    .all();

  return { pendingRefundRequests };
}

export async function action({ request }: Route.ActionArgs) {
  const staffUserId = await requireAdmin(request);

  const formData = await request.formData();
  const parsed = parseFormData(formData, decisionSchema);

  if (!parsed.success) {
    throw data("Invalid decision.", { status: 400 });
  }

  const { intent, refundRequestId } = parsed.data;

  try {
    const decided =
      intent === "approve"
        ? approveRefundRequest(refundRequestId, staffUserId)
        : declineRefundRequest(refundRequestId, staffUserId);

    sendEmail(buildRefundRequestDecidedEmail(decided));

    return { decided: decided.status };
  } catch (error) {
    if (error instanceof RefundRequestError) {
      throw data(error.message, { status: 409 });
    }
    throw error;
  }
}

export default function AdminRefundRequests({
  loaderData,
}: Route.ComponentProps) {
  const { pendingRefundRequests } = loaderData;

  return (
    <div className="mx-auto max-w-7xl p-6 lg:p-8">
      <nav className="mb-6 text-sm text-muted-foreground">
        <Link to="/" className="hover:text-foreground">
          Home
        </Link>
        <span className="mx-2">/</span>
        <span className="text-foreground">Refund Requests</span>
      </nav>

      <div className="mb-8">
        <h1 className="text-3xl font-bold">Refund Requests</h1>
        <p className="mt-1 text-muted-foreground">
          Approving refunds the whole amount the Learner paid and removes the
          course from their account.
        </p>
      </div>

      {pendingRefundRequests.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center">
            <Undo2 className="mx-auto mb-3 size-8 text-muted-foreground/50" />
            <p className="text-muted-foreground">
              No Pending Refund Requests.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {pendingRefundRequests.map((refundRequest) => (
            <PendingRefundRequest
              key={refundRequest.id}
              refundRequest={refundRequest}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function PendingRefundRequest({
  refundRequest,
}: {
  refundRequest: Route.ComponentProps["loaderData"]["pendingRefundRequests"][number];
}) {
  const fetcher = useFetcher<typeof action>();
  const isDeciding = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.decided) {
      toast.success(`Refund Request ${fetcher.data.decided}.`);
    }
  }, [fetcher.state, fetcher.data]);

  return (
    <Card>
      <CardContent className="space-y-3 pt-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <Link
              to={`/courses/${refundRequest.courseSlug}`}
              className="font-medium hover:underline"
            >
              {refundRequest.courseTitle}
            </Link>
            <p className="text-sm text-muted-foreground">
              {refundRequest.learnerName} ({refundRequest.learnerEmail}) ·{" "}
              {formatPrice(refundRequest.refundAmount)} · submitted{" "}
              {new Date(refundRequest.requestedAt).toLocaleDateString()}
            </p>
          </div>
          <fetcher.Form method="post" className="flex gap-2">
            <input
              type="hidden"
              name="refundRequestId"
              value={refundRequest.id}
            />
            <Button
              type="submit"
              name="intent"
              value="approve"
              size="sm"
              disabled={isDeciding}
            >
              Approve
            </Button>
            <Button
              type="submit"
              name="intent"
              value="decline"
              variant="outline"
              size="sm"
              disabled={isDeciding}
            >
              Decline
            </Button>
          </fetcher.Form>
        </div>
        <p className="text-sm">{refundRequest.reason}</p>
      </CardContent>
    </Card>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let title = "Something went wrong";
  let message = "An unexpected error occurred while loading Refund Requests.";

  if (isRouteErrorResponse(error)) {
    if (error.status === 401) {
      title = "Sign in required";
      message =
        typeof error.data === "string"
          ? error.data
          : "Please select a user from the DevUI panel.";
    } else if (error.status === 403) {
      title = "Access denied";
      message =
        typeof error.data === "string"
          ? error.data
          : "Only admins can access this page.";
    } else {
      title = `Error ${error.status}`;
      message = typeof error.data === "string" ? error.data : error.statusText;
    }
  }

  return (
    <div className="flex min-h-[50vh] items-center justify-center p-6">
      <div className="text-center">
        <AlertTriangle className="mx-auto mb-4 size-12 text-muted-foreground" />
        <h1 className="mb-2 text-2xl font-bold">{title}</h1>
        <p className="mb-6 text-muted-foreground">{message}</p>
        <Link to="/">
          <Button>Go Home</Button>
        </Link>
      </div>
    </div>
  );
}
