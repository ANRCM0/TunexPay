/**
 * 表格排序：各页面共用的客户端排序。
 *
 * 为什么放在客户端：管理台的列表都是有限的短列表（订单/退款/异常一页 20–100 条，
 * 对账批次、应用、通道等更少），排序在这个量级是瞬时的；也避免给每个列表新增后端
 * 排序参数、破坏现有 `?pageSize=` 契约。若将来列表涨到几千行，再把排序下推到 API，
 * 本模块的接口形态可以保持不变。
 *
 * 约定：
 *   - 三态循环：升序 → 降序 → 恢复默认（调用方传入的原始顺序）。
 *     第三个状态很重要：用户排完之后不该无路可退。
 *   - 空值（null / undefined / 空串）始终排在末尾，且不随升降序翻转 ——
 *     "没有值"不该占据列表顶部。
 *   - 未指定比较器时按 `type` 推断：number 用数值、date 用时间戳、text 用 zh-Hans-CN。
 *   - 相等时返回 0，由 sort 的稳定性保留原始相对顺序（现代 V8 的 Array#sort 稳定）。
 */

export type SortDirection = "asc" | "desc";
export type SortValueType = "text" | "number" | "date";

export type SortState = { key: string; direction: SortDirection } | null;

/** 单元格取值：给字段名即可，也可以用函数取拼接值或嵌套值。 */
export type SortAccessor<T> = (row: T) => unknown;

export type SortColumn<T> = {
  key: string;
  /** 表头文案，同时参与可访问名称。 */
  label: string;
  /** 取值方式；省略时按 `key` 从行对象取同名字段。 */
  accessor?: SortAccessor<T>;
  /** 覆盖推断出的比较方式。 */
  type?: SortValueType;
  /** 完全自定义比较，只在确实需要特殊规则时使用。 */
  compare?: (a: T, b: T) => number;
};

// 中文排序需要 locale 感知比较；模块级复用同一个 Collator，避免每次比较都构造
// （一次排序会调用它几千次）。
const collator = new Intl.Collator("zh-Hans-CN", { numeric: true, sensitivity: "base" });

/** 把值解析成数字；解析不出来返回 undefined，由调用方决定退回策略。 */
function parseNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/** 把值解析成时间戳；解析不出来返回 undefined。 */
function parseTime(value: unknown): number | undefined {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value.getTime();
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

function isEmpty(value: unknown): boolean {
  return value === null || value === undefined || value === "";
}

function readValue<T>(column: SortColumn<T>, row: T): unknown {
  if (column.accessor) return column.accessor(row);
  if (row !== null && typeof row === "object") return (row as Record<string, unknown>)[column.key];
  return undefined;
}

/** 推断列的取值类型：先看显式声明，再用首行数据的实际类型。 */
function inferType<T>(column: SortColumn<T>, sample: T | undefined): SortValueType {
  if (column.type) return column.type;
  if (sample === undefined) return "text";
  const value = readValue(column, sample);
  if (typeof value === "number") return "number";
  if (value instanceof Date) return "date";
  // ISO 时间串是管理台最常见的日期形态。用正则判断而不是 Date.parse 试探，
  // 否则 "20261001" 这类编号会被当成日期。
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}([T ]|$)/.test(value)) return "date";
  return "text";
}

/** 升序比较器（不含方向），空值不参与——空值在 sortRows 里单独排队。 */
function compareAscending<T>(column: SortColumn<T>, a: T, b: T, type: SortValueType): number {
  const left = readValue(column, a);
  const right = readValue(column, b);

  if (type === "number") {
    const l = parseNumber(left);
    const r = parseNumber(right);
    if (l !== undefined && r !== undefined) return l - r;
    return collator.compare(String(left), String(right));
  }
  if (type === "date") {
    const l = parseTime(left);
    const r = parseTime(right);
    if (l !== undefined && r !== undefined) return l - r;
    return collator.compare(String(left), String(right));
  }
  return collator.compare(String(left), String(right));
}

/**
 * 按当前状态排序。返回新数组，绝不原地改动传入数据 ——
 * 传入的通常是 useApi 的缓存对象，原地 sort 会造成难排查的串扰。
 */
export function sortRows<T>(rows: readonly T[], columns: readonly SortColumn<T>[], state: SortState): T[] {
  if (!state) return [...rows];
  const column = columns.find((item) => item.key === state.key);
  if (!column) return [...rows];

  const direction = state.direction === "asc" ? 1 : -1;
  const type = inferType(column, rows[0]);

  return [...rows].sort((a, b) => {
    if (column.compare) return column.compare(a, b) * direction;

    // 空值始终排在末尾：这里直接给出结果，不再乘方向，避免降序时空值跑到最前面
    const leftEmpty = isEmpty(readValue(column, a));
    const rightEmpty = isEmpty(readValue(column, b));
    if (leftEmpty !== rightEmpty) return leftEmpty ? 1 : -1;
    if (leftEmpty) return 0; // 两边都空，保持原顺序

    return compareAscending(column, a, b, type) * direction;
  });
}

/** 三态循环：无 → 升序 → 降序 → 无。点击同一列表头依次轮转。 */
export function nextSortState(current: SortState, key: string): SortState {
  if (!current || current.key !== key) return { key, direction: "asc" };
  if (current.direction === "asc") return { key, direction: "desc" };
  return null;
}
