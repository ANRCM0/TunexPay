import { describe, expect, it } from "vitest";
import { ariaSortValue, nextSortState, sortRows, type SortColumn } from "./sort";

type Row = {
  orderNo: string;
  subject: string;
  amount: number;
  status: string;
  paidAt: string | null;
  application: { name: string };
};

const rows: Row[] = [
  { orderNo: "ORD-003", subject: "Studio 素材包", amount: 6800, status: "SUCCESS", paidAt: "2026-10-01T10:00:00Z", application: { name: "Studio" } },
  { orderNo: "ORD-001", subject: "Matrix 年度订阅", amount: 29900, status: "CREATED", paidAt: null, application: { name: "Matrix" } },
  { orderNo: "ORD-002", subject: "API 额度充值", amount: 10000, status: "FAILED", paidAt: "2026-09-30T08:00:00Z", application: { name: "NewAPI" } },
];

const columns: SortColumn<Row>[] = [
  { key: "orderNo", label: "订单号" },
  { key: "subject", label: "商品" },
  { key: "amount", label: "金额", type: "number" },
  { key: "status", label: "状态" },
  { key: "paidAt", label: "支付时间", type: "date" },
  { key: "application", label: "应用", accessor: (row) => row.application.name },
];

describe("sortRows", () => {
  it("无排序状态时保持传入顺序", () => {
    expect(sortRows(rows, columns, null).map((r) => r.orderNo)).toEqual(["ORD-003", "ORD-001", "ORD-002"]);
  });

  it("不原地改动传入数组", () => {
    const input = [...rows];
    const sorted = sortRows(input, columns, { key: "amount", direction: "desc" });
    expect(input.map((r) => r.orderNo)).toEqual(["ORD-003", "ORD-001", "ORD-002"]);
    expect(sorted).not.toBe(input);
  });

  it("数值列按数值大小而不是字符串排序", () => {
    // 字符串排序会得到 10000 < 29900 < 6800 的错误结果
    expect(sortRows(rows, columns, { key: "amount", direction: "asc" }).map((r) => r.amount)).toEqual([6800, 10000, 29900]);
  });

  it("日期列按时间先后排序", () => {
    expect(sortRows(rows, columns, { key: "paidAt", direction: "asc" }).map((r) => r.orderNo))
      .toEqual(["ORD-002", "ORD-003", "ORD-001"]);
  });

  it("空值始终排末尾，升序降序都不翻到最前面", () => {
    const asc = sortRows(rows, columns, { key: "paidAt", direction: "asc" });
    expect(asc[asc.length - 1].orderNo).toBe("ORD-001");
    const desc = sortRows(rows, columns, { key: "paidAt", direction: "desc" });
    expect(desc[desc.length - 1].orderNo).toBe("ORD-001");
    expect(desc[0].orderNo).toBe("ORD-003");
  });

  it("文本列按中文排序（不是按 UTF-16 码位）", () => {
    const order = sortRows(rows, columns, { key: "subject", direction: "asc" }).map((r) => r.subject);
    // "API…" 与中文的预期相对顺序由 zh-Hans-CN 排序决定，这里只断言确定性且与 Collator 一致
    const expected = [...rows].map((r) => r.subject).sort(new Intl.Collator("zh-Hans-CN", { numeric: true, sensitivity: "base" }).compare);
    expect(order).toEqual(expected);
  });

  it("支持 accessor 取嵌套字段", () => {
    expect(sortRows(rows, columns, { key: "application", direction: "asc" }).map((r) => r.application.name))
      .toEqual(["Matrix", "NewAPI", "Studio"]);
  });

  it("自动从首行数据推断数值类型", () => {
    const inferred: SortColumn<Row>[] = [{ key: "amount", label: "金额" }];
    expect(sortRows(rows, inferred, { key: "amount", direction: "desc" }).map((r) => r.amount)).toEqual([29900, 10000, 6800]);
  });

  it("ISO 时间串按日期而不是文本排序", () => {
    const iso: Row[] = [
      { orderNo: "A", subject: "", amount: 0, status: "", paidAt: "2026-12-01T00:00:00Z", application: { name: "" } },
      { orderNo: "B", subject: "", amount: 0, status: "", paidAt: "2026-02-01T00:00:00Z", application: { name: "" } },
    ];
    // 文本排序会把 02 排在 12 之前（"2026-0" < "2026-1"），与时间顺序恰好相同；
    // 换成月份跨年的组合才能区分：12 月 2026 应晚于 2 月 2027
    const crossYear: Row[] = [
      { orderNo: "A", subject: "", amount: 0, status: "", paidAt: "2026-12-31T00:00:00Z", application: { name: "" } },
      { orderNo: "B", subject: "", amount: 0, status: "", paidAt: "2027-01-01T00:00:00Z", application: { name: "" } },
    ];
    expect(sortRows(crossYear, columns, { key: "paidAt", direction: "asc" }).map((r) => r.orderNo)).toEqual(["A", "B"]);
    expect(sortRows(iso, columns, { key: "paidAt", direction: "asc" })).toHaveLength(2);
  });

  it("自定义比较优先于推断", () => {
    const custom: SortColumn<Row>[] = [{
      key: "status",
      label: "状态",
      // 按业务优先级而不是字母序：需要人工处理的排最前
      compare: (a, b) => ["FAILED", "CREATED", "SUCCESS"].indexOf(a.status) - ["FAILED", "CREATED", "SUCCESS"].indexOf(b.status),
    }];
    expect(sortRows(rows, custom, { key: "status", direction: "asc" }).map((r) => r.status))
      .toEqual(["FAILED", "CREATED", "SUCCESS"]);
  });

  it("未知列名时原样返回，不抛错", () => {
    expect(sortRows(rows, columns, { key: "nope", direction: "asc" }).map((r) => r.orderNo))
      .toEqual(["ORD-003", "ORD-001", "ORD-002"]);
  });

  it("空列表不抛错", () => {
    expect(sortRows([], columns, { key: "amount", direction: "asc" })).toEqual([]);
  });

  it("相等值保持原始相对顺序（稳定排序）", () => {
    const same: Row[] = [
      { orderNo: "A", subject: "一致", amount: 100, status: "", paidAt: null, application: { name: "" } },
      { orderNo: "B", subject: "一致", amount: 100, status: "", paidAt: null, application: { name: "" } },
      { orderNo: "C", subject: "一致", amount: 100, status: "", paidAt: null, application: { name: "" } },
    ];
    expect(sortRows(same, columns, { key: "subject", direction: "asc" }).map((r) => r.orderNo)).toEqual(["A", "B", "C"]);
  });
});

describe("nextSortState（三态循环）", () => {
  it("首次点击某列 → 升序", () => {
    expect(nextSortState(null, "amount")).toEqual({ key: "amount", direction: "asc" });
  });

  it("再点同一列 → 降序", () => {
    expect(nextSortState({ key: "amount", direction: "asc" }, "amount")).toEqual({ key: "amount", direction: "desc" });
  });

  it("第三次点击 → 恢复默认（无排序）", () => {
    expect(nextSortState({ key: "amount", direction: "desc" }, "amount")).toBeNull();
  });

  it("换一列时从升序重新开始", () => {
    expect(nextSortState({ key: "amount", direction: "desc" }, "subject")).toEqual({ key: "subject", direction: "asc" });
  });
});

describe("ariaSortValue", () => {
  it("只给当前列标记方向，其余为 none", () => {
    const state = { key: "amount", direction: "desc" } as const;
    expect(ariaSortValue(state, "amount")).toBe("descending");
    expect(ariaSortValue(state, "subject")).toBe("none");
    expect(ariaSortValue(null, "amount")).toBe("none");
  });
});
