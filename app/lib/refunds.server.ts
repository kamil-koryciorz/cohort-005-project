import { and, desc, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";
import { db } from "~/db";
import {
  coupons,
  courses,
  enrollments,
  lessonProgress,
  lessons,
  LessonProgressStatus,
  modules,
  purchases,
  refunds,
  RefundStatus,
  users,
  videoWatchEvents,
} from "~/db/schema";
import { formatPrice } from "~/lib/utils";

// The language here follows GLOSSARY.md: a Learner submits a Refund Request,
// staff approve or decline it, and only an Approved one becomes a Refund.

export const REFUND_WINDOW_DAYS = 14;
export const REFUND_WATCH_LIMIT_SECONDS = 2 * 60 * 60;
export const REFUND_COMPLETION_LIMIT = 0.5;

export type RefundEligibility =
  | {
      eligible: true;
      purchaseId: number;
      refundAmount: number;
      lastDayOfRefundWindow: string;
    }
  | { eligible: false; reason: string };

// The Refund Window is counted in whole calendar days, not hours — someone who
// buys at 23:00 still gets the whole of their fourteenth day.
function calendarDay(when: Date): string {
  const month = String(when.getMonth() + 1).padStart(2, "0");
  const day = String(when.getDate()).padStart(2, "0");
  return `${when.getFullYear()}-${month}-${day}`;
}

function lastDayOfRefundWindow(purchasedAtIso: string): string {
  const deadline = new Date(purchasedAtIso);
  deadline.setDate(deadline.getDate() + REFUND_WINDOW_DAYS);
  return calendarDay(deadline);
}

function getLatestPurchase(userId: number, courseId: number) {
  return db
    .select()
    .from(purchases)
    .where(and(eq(purchases.userId, userId), eq(purchases.courseId, courseId)))
    .orderBy(desc(purchases.createdAt))
    .get();
}

function getLessonIdsForCourse(courseId: number): number[] {
  return db
    .select({ id: lessons.id })
    .from(lessons)
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .where(eq(modules.courseId, courseId))
    .all()
    .map((row) => row.id);
}

function getCompletedLessonCount(userId: number, lessonIds: number[]) {
  if (lessonIds.length === 0) return 0;

  const result = db
    .select({ count: sql<number>`count(*)` })
    .from(lessonProgress)
    .where(
      and(
        eq(lessonProgress.userId, userId),
        eq(lessonProgress.status, LessonProgressStatus.Completed),
        inArray(lessonProgress.lessonId, lessonIds)
      )
    )
    .get();

  return result?.count ?? 0;
}

function getSecondsWatched(userId: number, lessonIds: number[]) {
  if (lessonIds.length === 0) return 0;

  const furthestPerLesson = db
    .select({
      furthest: sql<number>`max(${videoWatchEvents.positionSeconds})`,
    })
    .from(videoWatchEvents)
    .where(
      and(
        eq(videoWatchEvents.userId, userId),
        inArray(videoWatchEvents.lessonId, lessonIds)
      )
    )
    .groupBy(videoWatchEvents.lessonId)
    .all();

  return furthestPerLesson.reduce((total, row) => total + row.furthest, 0);
}

// Any Refund Request other than a Withdrawn one ends Refund Eligibility: a
// Pending one is already being looked at, and an Approved or Declined one has
// had its decision.
function getBlockingRefundRequest(purchaseId: number) {
  return db
    .select({ status: refunds.status })
    .from(refunds)
    .where(
      and(
        eq(refunds.purchaseId, purchaseId),
        ne(refunds.status, RefundStatus.Withdrawn)
      )
    )
    .get();
}

/**
 * Refund Eligibility for a Learner's latest purchase of a Course, judged at
 * the moment of submitting a Refund Request.
 */
export function checkRefundEligibility(
  userId: number,
  courseId: number,
  now: Date = new Date()
): RefundEligibility {
  const purchase = getLatestPurchase(userId, courseId);

  if (!purchase) {
    return { eligible: false, reason: "You have not bought this course." };
  }

  const blocking = getBlockingRefundRequest(purchase.id);
  if (blocking?.status === RefundStatus.Pending) {
    return {
      eligible: false,
      reason: "You already have a Pending Refund Request for this course.",
    };
  }
  if (blocking) {
    return {
      eligible: false,
      reason: "A Refund Request for this purchase has already been decided.",
    };
  }

  const claimedSeat = db
    .select({ id: coupons.id })
    .from(coupons)
    .where(
      and(eq(coupons.purchaseId, purchase.id), isNotNull(coupons.redeemedAt))
    )
    .get();

  if (claimedSeat) {
    return {
      eligible: false,
      reason: "A claimed team seat cannot be refunded.",
    };
  }

  const lastDay = lastDayOfRefundWindow(purchase.createdAt);
  if (calendarDay(now) > lastDay) {
    return {
      eligible: false,
      reason: `The ${REFUND_WINDOW_DAYS}-day Refund Window has closed.`,
    };
  }

  const lessonIds = getLessonIdsForCourse(courseId);

  if (lessonIds.length > 0) {
    const completed = getCompletedLessonCount(userId, lessonIds);
    if (completed / lessonIds.length >= REFUND_COMPLETION_LIMIT) {
      return {
        eligible: false,
        reason: "You have completed too much of this course to get a Refund.",
      };
    }
  }

  if (getSecondsWatched(userId, lessonIds) >= REFUND_WATCH_LIMIT_SECONDS) {
    return {
      eligible: false,
      reason: "You have watched too much of this course to get a Refund.",
    };
  }

  return {
    eligible: true,
    purchaseId: purchase.id,
    // The Refund Amount is always exactly what the Learner paid.
    refundAmount: purchase.amountPaid,
    lastDayOfRefundWindow: lastDay,
  };
}

export function submitRefundRequest(purchaseId: number, reason: string) {
  return db
    .insert(refunds)
    .values({ purchaseId, status: RefundStatus.Pending, reason })
    .returning()
    .get();
}

function getRefundRequestDetails(refundRequestId: number) {
  return db
    .select({
      id: refunds.id,
      status: refunds.status,
      purchaseId: purchases.id,
      learnerId: users.id,
      learnerName: users.name,
      learnerEmail: users.email,
      courseId: courses.id,
      courseTitle: courses.title,
      refundAmount: purchases.amountPaid,
    })
    .from(refunds)
    .innerJoin(purchases, eq(refunds.purchaseId, purchases.id))
    .innerJoin(users, eq(purchases.userId, users.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(eq(refunds.id, refundRequestId))
    .get();
}

export type RefundRequestDetails = NonNullable<
  ReturnType<typeof getRefundRequestDetails>
>;

export class RefundRequestError extends Error {}

function requirePendingRefundRequest(refundRequestId: number) {
  const details = getRefundRequestDetails(refundRequestId);

  if (!details) {
    throw new RefundRequestError("Refund Request not found.");
  }
  if (details.status !== RefundStatus.Pending) {
    throw new RefundRequestError(
      `This Refund Request is already ${details.status}.`
    );
  }

  return details;
}

/** The Learner calls off their own Pending Refund Request. */
export function withdrawRefundRequest(
  learnerId: number,
  refundRequestId: number
): RefundRequestDetails {
  const details = requirePendingRefundRequest(refundRequestId);

  if (details.learnerId !== learnerId) {
    throw new RefundRequestError("Refund Request not found.");
  }

  db.update(refunds)
    .set({
      status: RefundStatus.Withdrawn,
      resolvedAt: new Date().toISOString(),
    })
    .where(eq(refunds.id, refundRequestId))
    .run();

  return { ...details, status: RefundStatus.Withdrawn };
}

/**
 * Staff approve a Pending Refund Request. The whole Refund Amount goes back
 * and the Learner loses access to the Course.
 */
export function approveRefundRequest(
  refundRequestId: number,
  staffUserId: number
): RefundRequestDetails {
  const details = requirePendingRefundRequest(refundRequestId);

  db.transaction((tx) => {
    tx.update(refunds)
      .set({
        status: RefundStatus.Approved,
        amountRefunded: details.refundAmount,
        resolvedAt: new Date().toISOString(),
        resolvedByUserId: staffUserId,
      })
      .where(eq(refunds.id, refundRequestId))
      .run();

    tx.delete(enrollments)
      .where(
        and(
          eq(enrollments.userId, details.learnerId),
          eq(enrollments.courseId, details.courseId)
        )
      )
      .run();
  });

  return { ...details, status: RefundStatus.Approved };
}

/** Staff decline a Pending Refund Request. Nothing is given back. */
export function declineRefundRequest(
  refundRequestId: number,
  staffUserId: number
): RefundRequestDetails {
  const details = requirePendingRefundRequest(refundRequestId);

  db.update(refunds)
    .set({
      status: RefundStatus.Declined,
      resolvedAt: new Date().toISOString(),
      resolvedByUserId: staffUserId,
    })
    .where(eq(refunds.id, refundRequestId))
    .run();

  return { ...details, status: RefundStatus.Declined };
}

export type Email = { to: string; subject: string; body: string };

/** Sent to the Learner as soon as their Refund Request is submitted. */
export function buildRefundRequestReceivedEmail(input: {
  learnerName: string;
  learnerEmail: string;
  courseTitle: string;
  refundAmount: number;
}): Email {
  return {
    to: input.learnerEmail,
    subject: `Refund Request received — ${input.courseTitle}`,
    body: [
      `Hi ${input.learnerName},`,
      "",
      `We have your Refund Request for "${input.courseTitle}".`,
      `If it is approved, we will refund ${formatPrice(input.refundAmount)}, the amount you paid, and the course will be removed from your account.`,
      "",
      "Our team reviews every Refund Request by hand. You do not need to do anything else — we will email you again once we have decided.",
      "",
      "— The Cadence team",
    ].join("\n"),
  };
}

/** Sent to the Learner once staff approve or decline their Refund Request. */
export function buildRefundRequestDecidedEmail(
  details: RefundRequestDetails
): Email {
  const approved = details.status === RefundStatus.Approved;

  return {
    to: details.learnerEmail,
    subject: approved
      ? `Refund approved — ${details.courseTitle}`
      : `Refund Request declined — ${details.courseTitle}`,
    body: [
      `Hi ${details.learnerName},`,
      "",
      approved
        ? `Your Refund Request for "${details.courseTitle}" has been approved. We are refunding ${formatPrice(details.refundAmount)} to the card you paid with, and the course has been removed from your account.`
        : `Your Refund Request for "${details.courseTitle}" has been declined, so there is no Refund. You still have full access to the course.`,
      "",
      "— The Cadence team",
    ].join("\n"),
  };
}

/** There is no mail transport wired up yet, so emails go to the server log. */
export function sendEmail(email: Email) {
  console.log(`[email] to=${email.to} subject=${email.subject}\n${email.body}`);
}
