import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ErrorState } from "./error-state";

// 错误边界本身只能在浏览器里触发，但边界渲染的这块 UI 可以单独验证：
// 文案、重试入口、错误编号和回首页链接都必须出现，且不能把异常原文带进界面。
describe("ErrorState", () => {
  it("renders the title, the explanation and the retry control", () => {
    const html = renderToStaticMarkup(<ErrorState title="页面加载失败" copy="管理台渲染这个页面时出错。" onRetry={() => undefined} />);
    expect(html).toContain('role="alert"');
    expect(html).toContain("页面加载失败");
    expect(html).toContain("管理台渲染这个页面时出错。");
    expect(html).toContain("重新加载");
    expect(html).not.toContain("返回首页");
  });

  it("shows the digest as a support handle and links home when asked", () => {
    const html = renderToStaticMarkup(<ErrorState title="标题" copy="说明" digest="abc123" onRetry={() => undefined} homeHref="/" />);
    expect(html).toContain("abc123");
    expect(html).toContain('href="/"');
    expect(html).toContain("返回首页");
  });

  it("omits the digest line when there is no digest to show", () => {
    const html = renderToStaticMarkup(<ErrorState title="标题" copy="说明" onRetry={() => undefined} />);
    expect(html).not.toContain("错误编号");
  });

  it("honours a custom retry label", () => {
    const html = renderToStaticMarkup(<ErrorState title="标题" copy="说明" retryLabel="再试一次" onRetry={() => undefined} />);
    expect(html).toContain("再试一次");
    expect(html).not.toContain("重新加载");
  });
});
