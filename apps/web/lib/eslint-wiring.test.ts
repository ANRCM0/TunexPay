import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// ESLint 接入的回归护栏。这里不重新实现一套 lint，只保证「接线没被拔掉」：
// 配置文件还在、规则还是 error、CI 里还有那一步。
// 具体 lint 行为由 eslint 自己执行（npm run lint），那种错误让它自己报。

function read(relative: string): string {
  return readFileSync(new URL(`../${relative}`, import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

// 边界说明（重要，别高估这条护栏）：
// eslint-plugin-jsx-a11y 的 label-has-associated-control 只检查「label 里有没有嵌套控件」，
// 不检查「控件有没有 label」。所以 <label>关键字</label><Input/> 这种真正最坑的分离写法
// 它是抓不到的 —— 那件事由 components/modal-form-layout.test.tsx 的 FilterItem 结构断言
// 加上 Playwright 实测覆盖。ESLint 在这里的价值是拦住 ARIA 属性拼错、
// div 挂 onClick、label 写得根本不嵌套这类低级错误。

describe("ESLint 接线", () => {
  it("配置文件存在且加载了 a11y 插件", () => {
    const config = read("eslint.config.mjs");
    expect(config).toContain("eslint-plugin-jsx-a11y");
    expect(config).toContain("jsxA11y.flatConfigs.recommended");
  });

  it("核心 a11y 规则是 error，不是 off", () => {
    const config = read("eslint.config.mjs");
    // 这些是引入 ESLint 的初衷：写下的那一刻就报错，而不是等人工审查
    for (const rule of ["jsx-a11y/label-has-associated-control", "jsx-a11y/alt-text", "jsx-a11y/aria-props"]) {
      // 规则必须以 "error" 或 ["error", ...] 的形式出现
      const pattern = new RegExp(`"${rule}":\\s*(\\[\\s*"error"|"error")`);
      expect(config, `${rule} 不再是 error 级`).toMatch(pattern);
    }
  });

  it("忽略项不会把整个 components 目录放掉", () => {
    const config = read("eslint.config.mjs");
    expect(config).not.toMatch(/globalIgnores\([^)]*components/);
  });

  it("package.json 有 lint 脚本，指向 eslint", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(pkg.scripts.lint).toContain("eslint");
  });

  it("CI 的 test 阶段先跑 lint", () => {
    // 顺序有意义：a11y 错误比测试失败更快暴露，先跑能给更短的反馈。
    const ci = readFileSync(new URL("../../../.github/workflows/docker.yml", import.meta.url), "utf8");
    const lintIndex = ci.indexOf("npm run lint --workspace @tuoxin-pay/web");
    const testIndex = ci.indexOf("- run: npm test");
    expect(lintIndex, "CI 里没有 lint 步骤").toBeGreaterThan(-1);
    expect(testIndex).toBeGreaterThan(-1);
    expect(lintIndex).toBeLessThan(testIndex);
  });

  it("依赖已安装且版本兼容（typescript-eslint 的 peer 曾经撞过 eslint 10）", () => {
    // 历史教训：typescript-eslint@8.46 要求 eslint ^8||^9，仓库里躺着 eslint 10，
    // 装不上。这里固定版本组合，避免下次手滑 upgrade 又撞一次。
    const pkg = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8"));
    expect(pkg.devDependencies.eslint).toBe("9.39.1");
    expect(pkg.devDependencies["typescript-eslint"]).toBe("8.71.1");
    expect(pkg.devDependencies["eslint-plugin-jsx-a11y"]).toBe("6.10.2");
  });
});
