import { describe, expect, it } from "vitest";
import { describeAdminAction } from "../middleware/admin-audit.js";

describe("admin audit descriptors", () => {
  it("names routing group configuration and application binding actions", () => {
    expect(describeAdminAction("POST", "/admin/v1/routing-groups")).toMatchObject({ action: "ROUTING_GROUP_CREATE", resourceType: "ROUTING_GROUP" });
    expect(describeAdminAction("POST", "/admin/v1/routing-groups/grp-1")).toMatchObject({ action: "ROUTING_GROUP_UPDATE", resourceId: "grp-1" });
    expect(describeAdminAction("POST", "/admin/v1/routing-groups/grp-1/delete")).toMatchObject({ action: "ROUTING_GROUP_DELETE" });
    expect(describeAdminAction("POST", "/admin/v1/applications/app-1/routing-group")).toMatchObject({ action: "APPLICATION_ROUTING_GROUP_CHANGE", resourceType: "APPLICATION", resourceId: "app-1" });
  });
  it("names sensitive administrator actions", () => {
    expect(describeAdminAction("POST", "/admin/v1/applications/app_1/rotate-api-key")).toEqual({
      action: "APPLICATION_API_KEY_ROTATE", resourceType: "APPLICATION", resourceId: "app_1",
    });
    expect(describeAdminAction("POST", "/admin/v1/payments/pay_1/close")).toEqual({
      action: "PAYMENT_CLOSE", resourceType: "PAYMENT", resourceId: "pay_1",
    });
  });

  it("names application lifecycle actions", () => {
    expect(describeAdminAction("POST", "/admin/v1/applications/app_1/rotate-credentials")).toEqual({
      action: "APPLICATION_CREDENTIAL_ROTATE", resourceType: "APPLICATION", resourceId: "app_1",
    });
    expect(describeAdminAction("POST", "/admin/v1/applications/app_1/status")).toEqual({
      action: "APPLICATION_STATUS_UPDATE", resourceType: "APPLICATION", resourceId: "app_1",
    });
    expect(describeAdminAction("POST", "/admin/v1/applications/app_1/delete")).toEqual({
      action: "APPLICATION_DELETE", resourceType: "APPLICATION", resourceId: "app_1",
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

  it("tracks manually initiated refunds separately from refund queries", () => {
    expect(describeAdminAction("POST", "/admin/v1/refunds")).toEqual({
      action: "REFUND_CREATE", resourceType: "REFUND", resourceId: null,
    });
    expect(describeAdminAction("POST", "/admin/v1/refunds/ref_1/query")).toEqual({
      action: "REFUND_QUERY", resourceType: "REFUND", resourceId: "ref_1",
    });
  });
});
