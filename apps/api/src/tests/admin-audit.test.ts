import { describe, expect, it } from "vitest";
import { describeAdminAction } from "../middleware/admin-audit.js";

describe("admin audit descriptors", () => {
  it("names sensitive administrator actions", () => {
    expect(describeAdminAction("POST", "/admin/v1/applications/app_1/rotate-api-key")).toEqual({
      action: "APPLICATION_API_KEY_ROTATE", resourceType: "APPLICATION", resourceId: "app_1",
    });
    expect(describeAdminAction("POST", "/admin/v1/payments/pay_1/close")).toEqual({
      action: "PAYMENT_CLOSE", resourceType: "PAYMENT", resourceId: "pay_1",
    });
  });

  it("extracts reconciliation receipt ids", () => {
    expect(describeAdminAction("POST", "/admin/v1/reconciliation/receipts/rcp_1/match")).toEqual({
      action: "RECEIPT_REMATCH", resourceType: "RECEIPT", resourceId: "rcp_1",
    });
  });

  it("tracks exception disposition changes", () => {
    expect(describeAdminAction("POST", "/admin/v1/exceptions/exc_1/status")).toEqual({
      action: "PAYMENT_EXCEPTION_UPDATE", resourceType: "PAYMENT_EXCEPTION", resourceId: "exc_1",
    });
  });
});
