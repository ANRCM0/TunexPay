import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { LoadingState } from "./common";

describe("LoadingState", () => {
  it("uses the skeleton for initial loading", () => {
    const html = renderToStaticMarkup(<LoadingState loading error=""><div>数据</div></LoadingState>);
    expect(html).toContain('aria-label="正在加载"');
    expect(html).not.toContain("数据</div>");
  });

  it("shows a retry action instead of pretending a failed initial load is empty", () => {
    const html = renderToStaticMarkup(<LoadingState loading={false} error="网络断开"><button>危险操作</button></LoadingState>);
    expect(html).toContain('role="alert"');
    expect(html).toContain("重新尝试");
    expect(html).not.toContain("危险操作");
    expect(html).toContain("网络断开");
  });

  it("retains explicitly confirmed old data when revalidation fails", () => {
    const html = renderToStaticMarkup(<LoadingState loading={false} stale error="请求超时"><div>之前的订单</div></LoadingState>);
    expect(html).toContain("之前的订单");
    expect(html).toContain("上次成功读取的数据");
  });

  it("does not show a stale empty list after refresh failure", () => {
    const html = renderToStaticMarkup(<LoadingState loading={false} stale empty error="请求超时"><div>空数据区</div></LoadingState>);
    expect(html).not.toContain("空数据区");
    expect(html).toContain("重新尝试");
  });
});
