import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// 这两组护栏守的是「长表单弹窗能不能把保存按钮送到用户面前」。
// 项目没有 jsdom，DOM 结构靠 renderToStaticMarkup 断言，布局效果靠浏览器验证
// （Playwright 量过：弹窗在 1440×720 / 1366×640 / 390×844 下都限高在视口内、
//  内容区内部可滚、操作栏常驻可点）。这里只保证「规则还在、组件还带着挂钩」，
// 不假装覆盖真实布局。

const CSS_PATH = new URL("../app/(admin)/admin.css", import.meta.url);

function css(): string {
  // 注释里写满了 class 名（.app-modal 的历史说明），扫规则前必须去掉，
  // 否则注释里的字符串会被当成真实的 CSS 规则。
  return readFileSync(CSS_PATH, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
}

/** 按声明块切分（每条规则以 { 开头到下一个 } 为止） */
function rules(source: string): string[] {
  return source
    .split("}")
    .filter((block) => block.includes("{"))
    .map((block) => block.slice(0, block.indexOf("{")).trim())
    .filter((selector) => selector.length > 0);
}

function tsx(name: string): string {
  return readFileSync(new URL(`./${name}`, import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

describe("Modal 的高度挂钩", () => {
  // Arco 的 Modal 走 Portal + 过渡挂载，renderToStaticMarkup 出来是空串，
  // 所以这里读源码断言 props（仓库对「标记层面定不下来的东西」都用源不变式）。
  const block = tsx("common.tsx").slice(tsx("common.tsx").indexOf("export function Modal("));

  it("className 与 wrapClassName 都带上，后者是 CSS 抬特异性的锚点", () => {
    // className 落在 .arco-modal 这一层（Arco 把 className 放这里，不是 content），
    // 宽度/限高规则才有地方生效；wrapClassName 对应 html .app-modal-layer 前缀。
    expect(block).toContain('className="app-modal"');
    expect(block).toContain('wrapClassName="app-modal-layer"');
  });

  it("alignCenter 保留：开关它会让弹窗贴顶，垂直居中是预期行为", () => {
    expect(block).toContain("alignCenter");
  });

  it("页面直接使用 Arco Modal 的自定义弹窗也带着同样的挂钩", () => {
    // applications / owner-notifications 没有走 common.tsx 的包装，
    // 漏掉 wrapClassName 的那些会退回组件库默认外观（无限高）。
    for (const name of ["applications.tsx", "owner-notifications.tsx"]) {
      const source = tsx(name);
      const uses = source.split("<Modal").length - 1;
      const withLayer = (source.match(/wrapClassName="app-modal-layer"/g) ?? []).length;
      expect(withLayer, `${name}: 有 ${uses} 处 <Modal>，只有 ${withLayer} 处带 wrapClassName`).toBe(uses);
    }
  });
});

describe("admin.css 的弹窗高度接管规则", () => {
  const source = css();
  const all = rules(source);

  it("存在限高规则，且作用在 .arco-modal 这一层", () => {
    const capRule = source
      .split("}")
      .find((block) => /\.arco-modal\.app-modal[^{]*\{[^}]*max-height/.test(block));
    expect(capRule).toBeDefined();
    expect(capRule).toMatch(/100dvh|100vh/);
  });

  it("内容区是滚动容器，且 overflow-y 明确为 auto", () => {
    const contentRule = source
      .split("}")
      .find((block) => /\.arco-modal\.app-modal[^{]*\.arco-modal-content[^{]*\{/.test(block) && /overflow-y:\s*auto/.test(block));
    expect(contentRule).toBeDefined();
  });

  it("flex 子项都带 min-height:0，否则限高会被内容顶穿", () => {
    // 这一条是实测踩过的坑：focusLock 会在 .arco-modal 与内容之间插入无类名容器，
    // 链条上任一环还是 min-height:auto（flex 子项默认值），长内容就会把限高整个顶穿。
    const blocks = source.split("}").filter((block) => block.includes("{"));
    // focusLock 插入的容器层
    const passthrough = blocks.find((block) => /\.arco-modal\.app-modal\s*>\s*\*/.test(block));
    expect(passthrough, "focusLock 容器层没有 min-height:0").toBeDefined();
    expect(passthrough).toMatch(/min-height:\s*0/);
    // 内容区本身
    const contentRule = blocks.find((block) => /\.arco-modal\.app-modal[^{]*\.arco-modal-content[^{]*\{/.test(block));
    expect(contentRule, "内容区没有 min-height:0").toBeDefined();
    expect(contentRule).toMatch(/min-height:\s*0/);
  });

  it("所有改 .arco-modal 外观的规则都加权到 (0,4,0)", () => {
    // .arco-modal-wrapper.arco-modal-wrapper-align-center .arco-modal 是 (0,3,0)，
    // 等特异性只比先后，而两张样式表的注入顺序不可依赖（实测被反超过）。
    // 所以每条想改 .arco-modal 自身盒模型的选择器都必须带 html + .app-modal-layer。
    const blocks = source.split("}").filter((block) => block.includes("{"));
    const weak: string[] = [];
    let weighted = 0;
    for (const block of blocks) {
      const selector = block.slice(0, block.indexOf("{")).trim();
      // 只看直接命中 .arco-modal 自身（不是它的后代）的那些规则
      const selfSelectors = selector.split(",").map((part) => part.trim())
        .filter((part) => /(^|[\s>])[^{}]*\.arco-modal\.app-modal(?:-wide)?[\s]*$/.test(part));
      if (!selfSelectors.length) continue;
      // 声明里出现的是会与 align-center 冲突的属性（display/top/width/max-height）
      if (!/display:|top:|width:|max-height:/.test(block)) continue;
      const allWeighted = selfSelectors.every((part) => /html\s+\.app-modal-layer\s+/.test(part));
      if (allWeighted) weighted += 1;
      else weak.push(selector.slice(0, 90));
    }
    expect(weighted, "一条加权规则都没有").toBeGreaterThan(0);
    expect(weak, "这些规则会输给组件库的 align-center").toEqual([]);
  });

  it("弹窗内操作栏常驻（sticky 贴住滚动容器底部）", () => {
    // 保存按钮在表单末尾：只靠整体滚动时，表单一长就被滚出视口。sticky 让它在任何滚动位置都可点。
    const actions = source
      .split("}")
      .find((block) => /\.bill-settings-actions[^{]*\{/.test(block) && /position:\s*sticky/.test(block));
    expect(actions).toBeDefined();
    expect(actions).toMatch(/bottom:\s*-?[\d.]+px/);
  });

  it("不再残留指向旧手写 .modal 的死规则", () => {
    // 迁移到 Arco 之前的 .modal / .modal-mask 规则已经不会命中任何元素，
    // 留着只会让人误以为弹窗样式还有人在管。
    const selectors = all.map((selector) => selector.split(",").map((part) => part.trim()));
    const flat = selectors.flat();
    const dead = flat.filter((selector) => /(^|[\s,>+~])\.modal([\s,>+~{]|$)/.test(selector));
    expect(dead).toEqual([]);
  });

  it("窄屏规则同样加权，避免只压过基础规则却输给 align-center", () => {
    const segments = source.split("@media (max-width: 700px)").slice(1);
    expect(segments.length).toBeGreaterThan(0);
    expect(segments.some((segment) => /\.app-modal-layer\s+\.arco-modal\.app-modal/.test(segment))).toBe(true);
  });
});

describe("筛选条件与控件的标签关联", () => {
  const source = readFileSync(new URL("./list.tsx", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");

  it("FilterItem 用 label 包裹，控件因此获得可访问名", () => {
    const start = source.indexOf("export function FilterItem(");
    const block = source.slice(start, source.indexOf("export function FilterInput("));
    expect(block).toContain("<label");
    expect(block).not.toContain("<div");
  });

  it("文案与控件都写在同一个 label 里（隐式关联成立的前提）", () => {
    // 读屏器能否念出名字，取决于控件是否嵌套在 label 内；
    // 这里确认结构没被拆成两个并列的 span/div。
    const start = source.indexOf("export function FilterItem(");
    const block = source.slice(start, source.indexOf("export function FilterInput("));
    const labelOpen = block.indexOf("<label");
    const labelClose = block.indexOf("</label>");
    expect(labelOpen).toBeGreaterThanOrEqual(0);
    expect(labelClose).toBeGreaterThan(labelOpen);
    const inner = block.slice(labelOpen, labelClose);
    expect(inner).toContain("filter-label");
    expect(inner).toContain("filter-control");
    // children（控件）必须在 label 内部才能隐式关联
    expect(inner).toContain("{children}");
  });

  it("filter-item 仍是 flex 布局（换标签不会改变横向排布）", () => {
    const styled = css().split("}").find((block) => /\.filter-item\s*\{/.test(block));
    expect(styled).toMatch(/display:\s*flex/);
  });
});
