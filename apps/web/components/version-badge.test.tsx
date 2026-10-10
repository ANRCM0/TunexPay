import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { VersionBadge } from "./version-badge";
import type { AppVersion } from "../lib/app-version";

// 服务端渲染的初始 HTML 必须自带版本号：徽标挂在侧边栏常驻可见，不能等客户端请求回来才出现，
// 否则首屏那一下会看到空白的左下角。effect 在静态渲染里不执行，所以这里断言的正是首屏状态。

const release: AppVersion = { version: "0.1.0", commit: null, source: "env" };

describe("VersionBadge", () => {
  it("prints the version on the first paint, with a v prefix", () => {
    expect(renderToStaticMarkup(<VersionBadge initial={release} />)).toContain("v0.1.0");
  });

  it("renders the status dot next to the version", () => {
    expect(renderToStaticMarkup(<VersionBadge initial={release} />)).toContain("version-dot");
  });

  it("does not claim the version was verified until the runtime probe answers", () => {
    expect(renderToStaticMarkup(<VersionBadge initial={release} />)).toContain('data-version-verified="false"');
  });

  it("exposes commit and source to hover and screen readers", () => {
    const html = renderToStaticMarkup(<VersionBadge initial={release} />);
      expect(html).toContain("来源：构建注入");
    expect(html).toContain("来源：构建注入");
  });

  it("degrades quietly when the build only knows a fallback version", () => {
    const html = renderToStaticMarkup(<VersionBadge initial={{ version: "0.1.0-dev", commit: null, source: "fallback" }} />);
    expect(html).toContain("v0.1.0-dev");
    expect(html).not.toContain("null");
  });
});
