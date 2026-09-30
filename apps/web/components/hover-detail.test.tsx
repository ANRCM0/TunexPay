import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { HoverDetail } from "./common";

// 这条约定的核心是「默认不展示」：详情只在悬浮/聚焦时才进 DOM，
// 因此服务端渲染出来的初始 HTML 里不应出现浮层节点（aria-label 仍带着全文，便于读屏）。
describe("HoverDetail", () => {
  it("renders no tooltip until it is opened", () => {
    const html = renderToStaticMarkup(<HoverDetail text="文件编码无法识别，请另存为 UTF-8 或 GBK 后重试"><span className="badge">失败</span></HoverDetail>);
    expect(html).toContain("失败");
    expect(html).not.toContain("hover-detail-pop");
    expect(html).not.toContain('role="tooltip"');
  });

  it("still exposes the detail to assistive tech and keyboard focus", () => {
    const html = renderToStaticMarkup(<HoverDetail text="小额实付验收通过"><span className="badge">实付已验证</span></HoverDetail>);
    expect(html).toContain('aria-label="小额实付验收通过"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain("hover-detail");
  });

  it("marks failures with the danger tone", () => {
    const html = renderToStaticMarkup(<HoverDetail text="通道返回 TRADE_STATUS_NOT_MATCH" tone="danger"><span className="badge">失败</span></HoverDetail>);
    expect(html).toContain("tone-danger");
  });

  it("renders children bare when there is nothing to reveal", () => {
    const html = renderToStaticMarkup(<HoverDetail text={null}><span className="badge">成功</span></HoverDetail>);
    expect(html).toBe('<span class="badge">成功</span>');
  });

  it("treats an empty string like no detail", () => {
    const html = renderToStaticMarkup(<HoverDetail text=""><span className="badge">成功</span></HoverDetail>);
    expect(html).not.toContain("hover-detail");
  });
});
