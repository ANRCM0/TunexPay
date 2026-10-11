import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// useApi 有一条容易被「顺手整理」破坏的契约：切换 path（翻页 / 筛选 / 排序）时
// 不清空已显示的数据。无条件 setData(null) 会让整表先闪成骨架屏再重建，
// 并让 stale 降级文案（「以下为上次成功读取的数据」）在翻页时永远走不到。
// 项目刻意不引入 jsdom（见 components/interaction-details.test.tsx 的说明），
// hook 级行为由浏览器验证；这里只守住源码层面的不变量，防止有人把条件清空改回无条件。
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const apiSource = stripComments(readFileSync(new URL("./api.ts", import.meta.url), "utf8"));

describe("useApi 保留已显示数据", () => {
  it("path 变化时的清空动作被「从未成功过」条件包住", () => {
    // 定位 path 变化的那个 effect：它以 setLoading(true) 开头
    const effectStart = apiSource.indexOf("setLoading(true)");
    expect(effectStart).toBeGreaterThan(-1);
    const resetAt = apiSource.indexOf("setData(null)", effectStart);
    expect(resetAt).toBeGreaterThan(effectStart);
    // 从 effect 开头到第一次清空之间必须出现条件判断：
    // 无条件执行就等于回到了「切一页闪一次骨架屏」的旧行为
    const segment = apiSource.slice(effectStart, resetAt);
    expect(segment).toMatch(/if\s*\(/);
  });

  it("成功与失败两条路径都把 path 写进 ref 镜像", () => {
    // ref 镜像让 path 变化的 effect 知道「之前有没有成功过」，又不会因此重新订阅。
    // 少写任何一条，切到出错的 path 之后再切回来就会被误判成首屏而清空数据。
    expect(apiSource.match(/resolvedPathRef\.current\s*=\s*path/g)?.length).toBe(2);
  });

  it("渲染闸门继续挡住未解析的 path，避免旧数据被当成新 path 的数据", () => {
    expect(apiSource).toContain("const pathPending = resolvedPath !== path");
    expect(apiSource).toContain("data: pathPending ? null : data");
  });
});
