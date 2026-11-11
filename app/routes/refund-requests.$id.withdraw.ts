import { data, redirect } from "react-router";
import { z } from "zod";
import type { Route } from "./+types/refund-requests.$id.withdraw";
import { requireUserId } from "~/lib/access.server";
import { parseParams } from "~/lib/validation";
import {
  RefundRequestError,
  withdrawRefundRequest,
} from "~/lib/refunds.server";

const withdrawParamsSchema = z.object({
  id: z.coerce.number().int(),
});

/** A Learner calls off their own Pending Refund Request. */
export async function action({ params, request }: Route.ActionArgs) {
  const learnerId = await requireUserId(request);
  const { id } = parseParams(params, withdrawParamsSchema);

  try {
    withdrawRefundRequest(learnerId, id);
  } catch (error) {
    if (error instanceof RefundRequestError) {
      throw data(error.message, { status: 409 });
    }
    throw error;
  }

  return redirect("/settings");
}
