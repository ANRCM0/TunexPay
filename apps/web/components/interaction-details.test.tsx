import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { CopyValue, SortableTh, Tabs, Toast } from "./common";

// 这些是「交互细节」的回归护栏。项目没有 jsdom，所以这里只验证标记层面能确定的部分：
// 读屏器依赖的角色/属性、表格列头关联、以及装饰图标不该被朗读。
// 依赖真实事件的部分（滚动复位、方向键切换、剪贴板回退）用浏览器验证，不在这里假装覆盖。

// 迁移到 Arco Table 后，列头不再由本仓库手写：sortHeader() 负责渲染列头按钮，
// 排序值也从 <td> 挪进单元格内的元素。扫描前先去掉注释，否则注释里提到的标记
// 会被当成真实代码（这类误报会让人误以为护栏在拦真问题）。
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

describe("表格列头关联", () => {
  it("每个列头都声明 scope=col（手写列头直接写，组件化的由组件自己保证）", () => {
    const dir = new URL(".", import.meta.url);
    const files = readdirSync(dir).filter((name) => name.endsWith(".tsx") && !name.endsWith(".test.tsx"));
    const offenders: string[] = [];
    let scoped = 0;
    let sortable = 0;
    let sortHeaderFiles = 0;

    for (const name of files) {
      const source = stripComments(readFileSync(new URL(name, dir), "utf8"));
      // 字面量列头必须是 <th scope="col">
      for (const match of source.match(/<th(\s|>)/g) ?? []) {
        const index = source.indexOf(match);
        if (!source.slice(index, index + 20).startsWith('<th scope="col"')) offenders.push(`${name}: ${match}`);
      }
      scoped += (source.match(/<th scope="col">/g) ?? []).length;
      // 两种排序列头形态都算：手写的 SortableTh，和 Arco 表格列用的 sortHeader()
      sortable += (source.match(/<SortableTh\b/g) ?? []).length;
      sortable += (source.match(/sortHeader\(/g) ?? []).length;
      if (source.includes("sortHeader(")) sortHeaderFiles += 1;
      // sortHeader 必须和排序状态配对，否则列头看着可点、点了没反应。
      // 状态可以由 useTableSort 提供，也可以直接用 nextSortState 自己管，两种都算。
      // 注意别写成 “useTableSort(”：泛型写法 useTableSort<Row>() 里没有那个左括号。
      if (source.includes("sortHeader(") && !/\buseTableSort\b/.test(source) && !/\bnextSortState\b/.test(source)) {
        offenders.push(`${name}: 用了 sortHeader 但没有排序状态（useTableSort / nextSortState 都没有）`);
      }
    }

    expect(offenders).toEqual([]);
    // 门槛只用来兜「组件化之后没人管了」，不追求精确计数：
    // 逐页迁移会让绝对值持续变化，卡死在某个具体数字上只会不断误报。
    expect(scoped + sortable).toBeGreaterThan(10);
    expect(sortHeaderFiles).toBeGreaterThan(0);
  });

  it("SortableTh 自己渲染出 scope=col 与 aria-sort，调用方不需要重复声明", () => {
    const html = renderToStaticMarkup(
      <table><thead><tr>
        <SortableTh label="金额" sortKey="amount" sort={{ key: "amount", direction: "desc" }} onSort={() => undefined} />
      </tr></thead></table>,
    );
    expect(html).toContain('scope="col"');
    expect(html).toContain('aria-sort="descending"');
    expect(html).toContain("金额");
  });

  it("同一个单元格上不会叠两个 sortValueProps（后写的会悄悄覆盖前一个）", () => {
    const dir = new URL(".", import.meta.url);
    const files = readdirSync(dir).filter((name) => name.endsWith(".tsx") && !name.endsWith(".test.tsx"));
    const offenders: string[] = [];
    let annotated = 0;

    for (const name of files) {
      const source = stripComments(readFileSync(new URL(name, dir), "utf8"));
      // 标注可以落在手写 <td> 上，也可以落在 Arco 单元格内容的外层元素上
      for (const tag of source.match(/<[A-Za-z][^>]*>/g) ?? []) {
        const count = (tag.match(/sortValueProps/g) ?? []).length;
        if (count > 1) offenders.push(`${name}: 属性叠加 ${tag.slice(0, 70)}`);
        if (count === 1) {
          annotated += 1;
          // 属性必须落在开标签内部：若被写到闭合标签之后就成了文本节点，
          // 浏览器不会报错，但排序值已经丢了
          if (!/^<[A-Za-z][^<>]*\{\.\.\.sortValueProps/.test(tag)) offenders.push(`${name}: 位置异常 ${tag.slice(0, 70)}`);
        }
      }
      // 也不应出现在标签之外（会成为文本节点）
      if (/>\s*\{\.\.\.sortValueProps/.test(source)) offenders.push(`${name}: 存在游离于标签外的 sortValueProps`);
    }

    expect(offenders).toEqual([]);
    // 同上：门槛只防「迁移后没人再标注排序值」，不锁死具体数值
    expect(annotated).toBeGreaterThan(5);
  });

  it("未排序的列头 aria-sort=none，且提示下一步动作", () => {
    const html = renderToStaticMarkup(
      <table><thead><tr>
        <SortableTh label="金额" sortKey="amount" sort={null} onSort={() => undefined} />
      </tr></thead></table>,
    );
    expect(html).toContain('aria-sort="none"');
    expect(html).toContain("按此列升序排序");
    // 整格可点，命中区域比文字大
    expect(html).toContain("<button");
  });
});

describe("装饰性图标不进入无障碍树", () => {
  it("复制按钮的图标标记为 aria-hidden", () => {
    const html = renderToStaticMarkup(<CopyValue value="ORD20261001103012001" label="复制订单号" />);
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("复制订单号");
  });

  it("Toast 的图标标记为 aria-hidden，文案仍然可读", () => {
    const html = renderToStaticMarkup(<Toast type="error" text="退款查询失败" onClose={() => undefined} />);
    expect(html).toContain('role="alert"');
    expect(html).toContain("退款查询失败");
    expect(html).toContain('aria-hidden="true"');
  });

  it("侧栏与顶栏图标同样隐藏（无外壳测试环境，检查源码约束）", () => {
    const shell = readFileSync(new URL("./shell.tsx", import.meta.url), "utf8");
    // 每个图标都必须在同一标签里带 aria-hidden，避免退化成"图标名 + 文案"双重朗读
    const iconTags = shell.match(/<[A-Z][A-Za-z]* size=\{\d+\}[^>]*>/g) ?? [];
    expect(iconTags.length).toBeGreaterThan(0);
    expect(iconTags.filter((tag) => !tag.includes('aria-hidden="true"'))).toEqual([]);
    // 侧栏图标是动态组件，单独确认渲染处也带了该属性
    expect(shell).toContain("<Icon size={17} aria-hidden=\"true\" />");
  });
});

describe("复制结果反馈", () => {
  it("初始只呈现可点击的复制按钮，不预先声称已复制", () => {
    const html = renderToStaticMarkup(<CopyValue value="PAY20261001103012001" />);
    expect(html).toContain("复制");
    expect(html).not.toContain("已复制");
    expect(html).not.toContain("复制失败");
  });

  it("实时区域就是可见文本本身，避免读屏器重复朗读", () => {
    const html = renderToStaticMarkup(<CopyValue value="X" />);
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    // 不能同时存在 sr-only 副本，否则会念成「已复制已复制」
    expect(html).not.toContain("sr-only");
    // 可见文本节点只有一处（title 提示里的"复制"不算，它不会被朗读两遍）
    const visibleText = html.match(/>[^<>]*复制[^<>]*</g) ?? [];
    expect(visibleText).toHaveLength(1);
    expect(visibleText[0]).toBe(">复制<");
  });

  it("按钮以可见文本作为可访问名称，提示放在 title 上", () => {
    const html = renderToStaticMarkup(<CopyValue value="X" label="复制支付单号" />);
    expect(html).toContain("<button");
    expect(html).toContain(">复制支付单号<");
    // 不应把 role 改成 status，否则按钮会从无障碍树里消失
    expect(html).not.toContain('role="status" aria-label');
    // 长句提示不应成为按钮名
    expect(html).not.toContain('aria-label="复制失败');
    expect(html).toContain('title="复制到剪贴板"');
  });
});

describe("标签页的 roving tabindex", () => {
  const items = ["概览", "事件时间线", "退款与通知"] as const;

  it("只有当前标签可 Tab 聚焦，其余为 -1", () => {
    const html = renderToStaticMarkup(<Tabs items={items} active="事件时间线" onChange={() => undefined} />);
    const tabs = html.match(/<button[^>]*role="tab"[^>]*>[^<]*/g) ?? [];
    expect(tabs).toHaveLength(3);
    const focusable = tabs.filter((tag) => tag.includes('tabindex="0"'));
    expect(focusable).toHaveLength(1);
    expect(focusable[0]).toContain('aria-selected="true"');
    expect(focusable[0]).toContain("事件时间线");
    expect(tabs.filter((tag) => tag.includes('tabindex="-1"'))).toHaveLength(2);
  });

  it("活动项变化时焦点目标随之移动", () => {
    const html = renderToStaticMarkup(<Tabs items={items} active="概览" onChange={() => undefined} />);
    const tabs = html.match(/<button[^>]*role="tab"[^>]*>[^<]*/g) ?? [];
    expect(tabs[0]).toContain('tabindex="0"');
    expect(tabs[1]).toContain('tabindex="-1"');
  });

  it("tablist 容器存在，方向键处理挂在其上", () => {
    const html = renderToStaticMarkup(<Tabs items={items} active="概览" onChange={() => undefined} />);
    expect(html).toContain('role="tablist"');
  });
});
