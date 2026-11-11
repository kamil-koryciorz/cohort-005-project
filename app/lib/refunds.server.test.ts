import { describe, it, expect, vi, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";

let testDb: ReturnType<typeof createTestDb>;

vi.mock("~/db", () => ({
  get db() {
    return testDb;
  },
}));

import {
  approveRefundRequest,
  buildRefundRequestDecidedEmail,
  buildRefundRequestReceivedEmail,
  checkRefundEligibility,
  declineRefundRequest,
  RefundRequestError,
  submitRefundRequest,
  withdrawRefundRequest,
} from "./refunds.server";

const NOW = new Date(2026, 10, 11, 12, 0, 0);

function daysBefore(days: number, hour = 12) {
  const when = new Date(NOW);
  when.setDate(when.getDate() - days);
  when.setHours(hour, 0, 0, 0);
  return when.toISOString();
}

let base: ReturnType<typeof seedBaseData>;
let lessonIds: number[];

function buy(amountPaid: number, purchasedDaysAgo = 1, hour = 12) {
  const purchase = testDb
    .insert(schema.purchases)
    .values({
      userId: base.user.id,
      courseId: base.course.id,
      amountPaid,
      createdAt: daysBefore(purchasedDaysAgo, hour),
    })
    .returning()
    .get();
  testDb
    .insert(schema.enrollments)
    .values({ userId: base.user.id, courseId: base.course.id })
    .run();
  return purchase;
}

function setRefundRequestStatus(id: number, status: schema.RefundStatus) {
  testDb
    .update(schema.refunds)
    .set({ status })
    .where(eq(schema.refunds.id, id))
    .run();
}

function eligibility() {
  return checkRefundEligibility(base.user.id, base.course.id, NOW);
}

beforeEach(() => {
  testDb = createTestDb();
  base = seedBaseData(testDb);
  const module = testDb
    .insert(schema.modules)
    .values({ courseId: base.course.id, title: "Module", position: 1 })
    .returning()
    .get();
  lessonIds = [1, 2, 3, 4].map(
    (position) =>
      testDb
        .insert(schema.lessons)
        .values({ moduleId: module.id, title: `Lesson ${position}`, position })
        .returning()
        .get().id
  );
});

describe("checkRefundEligibility", () => {
  it("offers the whole amount the Learner paid as the Refund Amount", () => {
    buy(3950);
    expect(eligibility()).toMatchObject({ eligible: true, refundAmount: 3950 });
  });

  it("is not eligible without a purchase", () => {
    expect(eligibility().eligible).toBe(false);
  });

  it("keeps the Refund Window open through the whole fourteenth day", () => {
    buy(7900, 14, 23);
    expect(eligibility().eligible).toBe(true);
  });

  it("closes the Refund Window on the fifteenth day", () => {
    buy(7900, 15);
    expect(eligibility()).toMatchObject({
      eligible: false,
      reason: expect.stringContaining("Refund Window"),
    });
  });

  it("is not eligible once half the lessons are completed", () => {
    buy(7900);
    testDb
      .insert(schema.lessonProgress)
      .values(
        lessonIds.slice(0, 2).map((lessonId) => ({
          userId: base.user.id,
          lessonId,
          status: schema.LessonProgressStatus.Completed,
        }))
      )
      .run();
    expect(eligibility()).toMatchObject({
      eligible: false,
      reason: expect.stringContaining("completed too much"),
    });
  });

  it("is not eligible after two hours watched", () => {
    buy(7900);
    testDb
      .insert(schema.videoWatchEvents)
      .values(
        lessonIds.slice(0, 2).map((lessonId) => ({
          userId: base.user.id,
          lessonId,
          eventType: "progress",
          positionSeconds: 3600,
        }))
      )
      .run();
    expect(eligibility()).toMatchObject({
      eligible: false,
      reason: expect.stringContaining("watched too much"),
    });
  });

  it("is not eligible for a claimed team seat", () => {
    const purchase = buy(7900);
    const team = testDb.insert(schema.teams).values({}).returning().get();
    testDb
      .insert(schema.coupons)
      .values({
        teamId: team.id,
        courseId: base.course.id,
        code: "SEAT-1",
        purchaseId: purchase.id,
        redeemedByUserId: base.user.id,
        redeemedAt: daysBefore(0),
      })
      .run();
    expect(eligibility().eligible).toBe(false);
  });

  it("is not eligible while a Refund Request is Pending", () => {
    const purchase = buy(7900);
    submitRefundRequest(purchase.id, "Not what I expected.");
    expect(eligibility()).toMatchObject({
      eligible: false,
      reason: expect.stringContaining("Pending"),
    });
  });

  it("is not eligible again after a Declined Refund Request", () => {
    const purchase = buy(7900);
    const request = submitRefundRequest(purchase.id, "Not what I expected.");
    setRefundRequestStatus(request.id, schema.RefundStatus.Declined);
    expect(eligibility().eligible).toBe(false);
  });

  it("is eligible again after a Withdrawn Refund Request", () => {
    const purchase = buy(7900);
    const request = submitRefundRequest(purchase.id, "Not what I expected.");
    setRefundRequestStatus(request.id, schema.RefundStatus.Withdrawn);
    expect(eligibility().eligible).toBe(true);
  });
});

describe("deciding a Refund Request", () => {
  it("submits a Refund Request as Pending", () => {
    const purchase = buy(7900);
    const request = submitRefundRequest(purchase.id, "Not what I expected.");
    expect(request.status).toBe(schema.RefundStatus.Pending);
  });

  it("approving refunds the whole Refund Amount and removes access", () => {
    const purchase = buy(3950);
    const request = submitRefundRequest(purchase.id, "Not what I expected.");

    approveRefundRequest(request.id, base.instructor.id);

    const stored = testDb
      .select()
      .from(schema.refunds)
      .where(eq(schema.refunds.id, request.id))
      .get();
    expect(stored).toMatchObject({
      status: schema.RefundStatus.Approved,
      amountRefunded: 3950,
      resolvedByUserId: base.instructor.id,
    });
    expect(testDb.select().from(schema.enrollments).all()).toHaveLength(0);
  });

  it("declining keeps access and refunds nothing", () => {
    const purchase = buy(7900);
    const request = submitRefundRequest(purchase.id, "Not what I expected.");

    declineRefundRequest(request.id, base.instructor.id);

    const stored = testDb
      .select()
      .from(schema.refunds)
      .where(eq(schema.refunds.id, request.id))
      .get();
    expect(stored?.status).toBe(schema.RefundStatus.Declined);
    expect(stored?.amountRefunded).toBeNull();
    expect(testDb.select().from(schema.enrollments).all()).toHaveLength(1);
  });

  it("lets the Learner withdraw their own Pending Refund Request", () => {
    const purchase = buy(7900);
    const request = submitRefundRequest(purchase.id, "Not what I expected.");

    const withdrawn = withdrawRefundRequest(base.user.id, request.id);

    expect(withdrawn.status).toBe(schema.RefundStatus.Withdrawn);
  });

  it("does not let anyone else withdraw a Learner's Refund Request", () => {
    const purchase = buy(7900);
    const request = submitRefundRequest(purchase.id, "Not what I expected.");

    expect(() => withdrawRefundRequest(base.instructor.id, request.id)).toThrow(
      RefundRequestError
    );
  });

  it("cannot decide a Refund Request that is no longer Pending", () => {
    const purchase = buy(7900);
    const request = submitRefundRequest(purchase.id, "Not what I expected.");
    withdrawRefundRequest(base.user.id, request.id);

    expect(() => approveRefundRequest(request.id, base.instructor.id)).toThrow(
      RefundRequestError
    );
  });
});

describe("Refund emails", () => {
  it("confirms a Refund Request with the amount the Learner paid", () => {
    const email = buildRefundRequestReceivedEmail({
      learnerName: "Maya",
      learnerEmail: "maya@example.com",
      courseTitle: "Intro to TypeScript",
      refundAmount: 3950,
    });

    expect(email.subject).toBe("Refund Request received — Intro to TypeScript");
    expect(email.body).toContain("$39.50, the amount you paid");
    expect(email.body).not.toMatch(/reversal|chargeback|cancel/i);
  });

  it("tells the Learner when their Refund Request is approved", () => {
    const purchase = buy(3950);
    const request = submitRefundRequest(purchase.id, "Not what I expected.");
    const email = buildRefundRequestDecidedEmail(
      approveRefundRequest(request.id, base.instructor.id)
    );

    expect(email.subject).toBe("Refund approved — Test Course");
    expect(email.body).toContain("$39.50");
  });
});
