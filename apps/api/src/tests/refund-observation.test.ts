import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(), refundCall: vi.fn(), raw: vi.fn(), update: vi.fn(), updateMany: vi.fn(), event: vi.fn(), transactionOptions: vi.fn(),
  delivery: vi.fn(), resolveException: vi.fn(), exists: true,
  state: {} as { id: string; refundNo: string; paymentId: string; amount: number; status: string; queryAttempts: number; nextQueryAt: Date | null; channelRefundNo?: string },
}));
vi.mock("../services/channel-instance-service.js", () => ({ adapterForPayment: async () => ({ queryRefund: mocks.query, refund: mocks.refundCall }) }));
vi.mock("../services/outbox-service.js", () => ({ createRefundSucceededDelivery: mocks.delivery }));
vi.mock("../services/payment-exception-service.js", () => ({ resolveLateDuplicateExceptionAfterRefund: mocks.resolveException }));
vi.mock("../db.js", () => {
  const payment = { id: "p1", paymentNo: "pay_1", status: "SUCCESS", channel: "ALIPAY", amount: 100, orderId: "o1", order: { id: "o1", amount: 100, winningPaymentId: "p1", application: {} } };
  const refund = {
    findFirst: vi.fn(async () => ({ ...mocks.state, payment })),
    findUnique: vi.fn(async () => mocks.exists ? { ...mocks.state } : null),
    findUniqueOrThrow: vi.fn(async () => ({ ...mocks.state })),
    create: vi.fn(async ({ data }) => { Object.assign(mocks.state, data); mocks.exists = true; return { ...mocks.state }; }),
    update: mocks.update,
    updateMany: mocks.updateMany,
    aggregate: vi.fn(async () => ({ _sum: { amount: mocks.state.status === "SUCCESS" ? 100 : 0 } })),
  };
  const tx = {
    $queryRaw: mocks.raw, refund, payment: { findFirst: vi.fn(async () => payment), findUniqueOrThrow: vi.fn(async () => payment) },
    order: { update: vi.fn(async ({ data }) => ({ ...payment.order, ...data })) }, paymentEvent: { create: mocks.event },
  };
  return { db: { ...tx, $transaction: async (fn: (tx: unknown) => unknown, options?: unknown) => { mocks.transactionOptions(options); return fn(tx); } } };
});
import { createRefund, queryRefund } from "../services/refund-service.js";
import { ChannelUncertainError } from "../lib/errors.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.exists = true;
  mocks.state = { id: "r1", refundNo: "ref_1", paymentId: "p1", amount: 100, status: "UNKNOWN", queryAttempts: 2, nextQueryAt: null };
  mocks.update.mockImplementation(async ({ data }) => { Object.assign(mocks.state, data); return { ...mocks.state }; });
});

describe("refund observations after concurrent success", () => {
  it.each(["failure-result", "uncertain-error"])("keeps a concurrent success when the original refund request finishes with %s", async mode => {
    mocks.exists = false;
    mocks.state.status = "CREATED";
    const observation = deferred<{ status: string; raw: object }>();
    const started = deferred<void>();
    mocks.refundCall.mockImplementationOnce(async () => {
      started.resolve();
      const result = await observation.promise;
      if (mode === "uncertain-error") throw new ChannelUncertainError("old timeout");
      return result;
    });
    const creating = createRefund({ id: "a1" } as never, { paymentNo: "pay_1", externalRefundNo: "external_ref_1", amount: 100 });
    await started.promise;
    // 原始退款请求还在飞的时候，另一个人工查单已经把它确认为成功。
    mocks.query.mockResolvedValueOnce({ status: "SUCCESS", raw: {}, channelRefundNo: "trade_refund" });
    await queryRefund(null, "ref_1");
    observation.resolve({ status: "FAILED", raw: { stale: true } });
    expect((await creating).status).toBe("SUCCESS");
    expect(mocks.state).toMatchObject({ status: "SUCCESS", nextQueryAt: null, channelRefundNo: "trade_refund" });
    expect(mocks.update).toHaveBeenCalledTimes(1);
    expect(mocks.event).toHaveBeenCalledTimes(3);
    expect(mocks.delivery).toHaveBeenCalledTimes(1);
  });
  it.each(["PROCESSING", "FAILED"])("does not let a delayed %s observation downgrade success", async status => {
    const observation = deferred<{ status: string; raw: object }>();
    const started = deferred<void>();
    mocks.query.mockImplementationOnce(() => { started.resolve(); return observation.promise; });
    mocks.query.mockResolvedValueOnce({ status: "SUCCESS", raw: {}, channelRefundNo: "trade_refund" });
    const staleQuery = queryRefund(null, "ref_1");
    await started.promise;
    expect((await queryRefund(null, "ref_1")).status).toBe("SUCCESS");
    observation.resolve({ status, raw: { stale: true } });
    expect((await staleQuery).status).toBe("SUCCESS");
    expect(mocks.state).toMatchObject({ status: "SUCCESS", nextQueryAt: null, channelRefundNo: "trade_refund" });
    expect(mocks.update).toHaveBeenCalledTimes(1);
    expect(mocks.event).toHaveBeenCalledTimes(1);
    expect(mocks.delivery).toHaveBeenCalledTimes(1);
    expect(mocks.raw).toHaveBeenCalledTimes(2);
  });

  it("does not schedule a follow-up query after a delayed unchanged observation", async () => {
    const observation = deferred<{ status: string; raw: object }>();
    const started = deferred<void>();
    mocks.query.mockImplementationOnce(() => { started.resolve(); return observation.promise; });
    mocks.query.mockResolvedValueOnce({ status: "SUCCESS", raw: {} });
    const staleQuery = queryRefund(null, "ref_1");
    await started.promise;
    await queryRefund(null, "ref_1");
    observation.resolve({ status: "UNKNOWN", raw: {} });
    // 结论来自并发成功的确认，而不是这次陈旧的 UNKNOWN 观察。
    expect((await staleQuery).status).toBe("SUCCESS");
    expect(mocks.state.nextQueryAt).toBeNull();
    // 关键回归点：系统不再自动查退款，任何路径都不该写回 nextQueryAt。
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it("updates a valid current observation without scheduling recovery", async () => {
    mocks.query.mockResolvedValue({ status: "PROCESSING", raw: {} });
    const refund = await queryRefund(null, "ref_1");
    expect(refund.status).toBe("PROCESSING");
    expect(refund.nextQueryAt).toBeNull();
    expect(mocks.transactionOptions).toHaveBeenLastCalledWith({ isolationLevel: "ReadCommitted" });
    expect(mocks.raw).toHaveBeenCalledTimes(1);
    expect(mocks.event).toHaveBeenCalledTimes(1);
  });

  it("does not reopen a concurrently failed refund using an older processing observation", async () => {
    mocks.query.mockImplementation(async () => { mocks.state.status = "FAILED"; return { status: "PROCESSING", raw: {} }; });
    expect((await queryRefund(null, "ref_1")).status).toBe("FAILED");
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.event).not.toHaveBeenCalled();
  });
});
