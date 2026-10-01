import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  paymentFindUnique: vi.fn(),
  createRefund: vi.fn(),
  queryRefund: vi.fn(),
  auditCreate: vi.fn(),
}));

vi.mock("../db.js", () => {
  const empty = async () => 0;
  const none = async () => null;
  const list = async () => [];
  return {
    db: {
      payment: { findUnique: mocks.paymentFindUnique, findFirst: none, count: empty, findMany: list },
      adminAuditLog: { create: mocks.auditCreate, count: empty, findMany: list },
      application: { count: empty, findMany: list },
      order: { count: empty, findMany: list },
      refund: { count: empty, findMany: list, findFirst: none },
      receipt: { count: empty, findMany: list },
      paymentException: { count: empty, findMany: list },
      webhookDelivery: { count: empty, findFirst: none },
      notificationInstance: { count: empty, findMany: list },
      mcpActionApproval: { findMany: list, updateMany: async () => ({ count: 0 }) },
    },
  };
});

// createRefund 自身的事务/并发语义由 refund-observation.test.ts 覆盖，
// 这里只验证「管理台人工入口」把参数正确地交给了它。
vi.mock("../services/refund-service.js", () => ({ createRefund: mocks.createRefund, queryRefund: mocks.queryRefund }));

import { app } from "../app.js";

const AUTH = { Authorization: "Bearer development-admin-token-change-me", "content-type": "application/json" };

const APPLICATION = { id: "app_1", name: "测试应用" };
const SUCCESS_PAYMENT = {
  id: "p1",
  paymentNo: "pay_1",
  status: "SUCCESS",
  order: { id: "o1", orderNo: "TXP20261001001", deletedAt: null, application: APPLICATION },
};

function postRefund(body: unknown) {
  return app.request("/admin/v1/refunds", { method: "POST", headers: AUTH, body: JSON.stringify(body) });
}

const VALID = { paymentNo: "pay_1", amount: 1234, reason: "用户申请取消订单", idempotencyKey: "admin-key-1234" };

/** 审计中间件每次变更请求都会写一条记录，失败路径也会写。 */
function auditEntry() {
  expect(mocks.auditCreate).toHaveBeenCalled();
  return mocks.auditCreate.mock.calls.at(-1)![0].data as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.paymentFindUnique.mockResolvedValue(SUCCESS_PAYMENT);
  mocks.createRefund.mockResolvedValue({ refundNo: "ref_1", status: "PROCESSING", amount: 1234 });
  mocks.auditCreate.mockResolvedValue({});
});

describe("POST /admin/v1/refunds (manual refund)", () => {
  it("requires the admin token and never reaches the refund service", async () => {
    const response = await app.request("/admin/v1/refunds", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(VALID) });
    expect(response.status).toBe(401);
    expect(mocks.createRefund).not.toHaveBeenCalled();
  });

  it("creates a refund through createRefund and records a REFUND_CREATE audit entry", async () => {
    const response = await postRefund(VALID);
    expect(response.status).toBe(201);
    expect((await response.json()).data).toMatchObject({ refundNo: "ref_1", status: "PROCESSING" });

    // 应用从支付单推导，不需要管理员指定；幂等号由 idempotencyKey 决定。
    expect(mocks.createRefund).toHaveBeenCalledWith(APPLICATION, {
      paymentNo: "pay_1",
      externalRefundNo: "admin_admin-key-1234",
      amount: 1234,
      reason: "用户申请取消订单",
    });
    expect(auditEntry()).toMatchObject({ action: "REFUND_CREATE", resourceType: "REFUND", success: true, statusCode: 201, errorCode: null });
  });

  it("derives a unique admin refund number when no idempotency key is supplied", async () => {
    const { idempotencyKey, ...withoutKey } = VALID;
    expect(idempotencyKey).toBeDefined();
    await postRefund(withoutKey);
    const [, input] = mocks.createRefund.mock.calls[0]! as [unknown, { externalRefundNo: string }];
    expect(input.externalRefundNo).toMatch(/^admin_[0-9a-f-]{36}$/);

    mocks.createRefund.mockClear();
    await postRefund(withoutKey);
    const [, second] = mocks.createRefund.mock.calls[0]! as [unknown, { externalRefundNo: string }];
    expect(second.externalRefundNo).not.toBe(input.externalRefundNo);
  });

  it("rejects a payment that is not successful", async () => {
    mocks.paymentFindUnique.mockResolvedValue({ ...SUCCESS_PAYMENT, status: "PROCESSING" });
    const response = await postRefund(VALID);
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("PAYMENT_NOT_REFUNDABLE");
    expect(mocks.createRefund).not.toHaveBeenCalled();
    // Hono 在审计中间件之前就把抛出的 AppError 变成了响应，所以这里能拿到错误码要靠
    // 读 context.error（见 middleware/admin-audit.ts 的说明）。
    expect(auditEntry()).toMatchObject({ action: "REFUND_CREATE", resourceType: "REFUND", success: false, statusCode: 409, errorCode: "PAYMENT_NOT_REFUNDABLE" });
  });

  it("records the validation error code for malformed bodies", async () => {
    const response = await postRefund({ ...VALID, amount: 0 });
    expect(response.status).toBe(422);
    expect(auditEntry()).toMatchObject({ action: "REFUND_CREATE", success: false, statusCode: 422, errorCode: "VALIDATION_ERROR" });
  });

  it("records the business error code for archived applications", async () => {
    mocks.paymentFindUnique.mockResolvedValue({ ...SUCCESS_PAYMENT, order: { ...SUCCESS_PAYMENT.order, deletedAt: new Date() } });
    const response = await postRefund(VALID);
    expect(response.status).toBe(404);
    expect(auditEntry()).toMatchObject({ success: false, statusCode: 404, errorCode: "PAYMENT_NOT_FOUND" });
  });

  it("records INTERNAL_ERROR when a handler throws an unexpected error", async () => {
    mocks.paymentFindUnique.mockRejectedValue(new Error("ECONNREFUSED"));
    const response = await postRefund(VALID);
    expect(response.status).toBe(500);
    expect((await response.json()).error.code).toBe("INTERNAL_ERROR");
    expect(auditEntry()).toMatchObject({ success: false, statusCode: 500, errorCode: "INTERNAL_ERROR" });
  });

  it("refuses payments of archived applications instead of reporting a missing payment", async () => {
    mocks.paymentFindUnique.mockResolvedValue({ ...SUCCESS_PAYMENT, order: { ...SUCCESS_PAYMENT.order, deletedAt: new Date() } });
    const response = await postRefund(VALID);
    expect(response.status).toBe(404);
    expect((await response.json()).error.message).toContain("归档");
    expect(mocks.createRefund).not.toHaveBeenCalled();
  });

  it("reports an unknown payment number", async () => {
    mocks.paymentFindUnique.mockResolvedValue(null);
    const response = await postRefund(VALID);
    expect(response.status).toBe(404);
    expect(mocks.createRefund).not.toHaveBeenCalled();
  });

  it("rejects malformed amounts and short reasons before touching the payment", async () => {
    for (const body of [
      { ...VALID, amount: 0 },
      { ...VALID, amount: 12.34 },
      { ...VALID, amount: -100 },
      { ...VALID, reason: "x" },
      { ...VALID, idempotencyKey: "bad key!" },
      { ...VALID, paymentNo: "" },
    ]) {
      mocks.paymentFindUnique.mockClear();
      const response = await postRefund(body);
      expect(response.status, JSON.stringify(body)).toBe(422);
      expect(mocks.createRefund, JSON.stringify(body)).not.toHaveBeenCalled();
      expect(mocks.paymentFindUnique, JSON.stringify(body)).not.toHaveBeenCalled();
    }
  });
});
