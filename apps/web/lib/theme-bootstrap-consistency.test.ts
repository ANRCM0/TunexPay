import { describe, expect, it } from "vitest";
import { themeBootstrapScript, themeVars, DEFAULT_COLORS, PRESETS, type ThemeColors } from "./theme";

/* ------------------------------------------------------------------ *
 * 首屏脚本与运行时公式的一致性
 *
 * themeBootstrapScript() 把纯函数 toString() 后拼进内联脚本，让首屏用的
 * 公式与运行时用的完全一致。theme.test.ts 的「引导脚本完整性」一节已经
 * 守住了「依赖的函数都在脚本里」和「执行后能写入变量」。
 *
 * 这里补上最后一条：脚本算出来的【值】必须与 themeVars() 完全相等。
 * 少了它，「两边公式悄悄改岔」不会有任何报错 —— 脚本自己的 try/catch
 * 吞异常，运行时又正常，现象只是首屏和挂载后配色不一致，极难定位。
 * ------------------------------------------------------------------ */

function runScript(script: string, options: { colors: ThemeColors; dark: boolean }): Record<string, string> {
  const style: Record<string, string> = {};
  const body = {
    setAttribute: (key: string, value: string) => { style["@" + key] = value; },
    style: {
      setProperty: (key: string, value: string) => { style[key] = value; },
      removeProperty: (key: string) => { delete style[key]; },
    },
  };
  const win = {
    localStorage: {
      getItem: (key: string) => (key === "tuoxin.colors" ? JSON.stringify(options.colors) : key === "tuoxin.theme" ? (options.dark ? "dark" : "light") : null),
      setItem: () => {},
      removeItem: () => {},
    },
    matchMedia: () => ({ matches: options.dark }),
  };
  // __name 是某些打包器 keepNames 转换注入的辅助函数，真实 SWC 构建没有；
  // 与 theme.test.ts 的冒烟测试保持同一套处理。
  new Function("window", "document", "__name", script)(win, { body, addEventListener: () => {} }, (fn: unknown) => fn);
  return style;
}

describe("themeBootstrapScript 与 themeVars 的值一致性", () => {
  const cases: { name: string; colors: ThemeColors }[] = [
    { name: "默认色", colors: DEFAULT_COLORS },
    ...PRESETS.map(preset => ({ name: `预设「${preset.name}」`, colors: preset.colors })),
  ];

  for (const { name, colors } of cases) {
    for (const dark of [false, true]) {
      it(`${name}（${dark ? "深色" : "浅色"}）脚本算出的变量与 themeVars 完全一致`, () => {
        const fromScript = runScript(themeBootstrapScript(), { colors, dark });
        const expected = themeVars(colors, dark);
        expect(Object.keys(fromScript).filter(key => !key.startsWith("@")).sort())
          .toEqual(Object.keys(expected).sort());
        for (const [key, value] of Object.entries(expected)) {
          expect(fromScript[key], `${key} 不一致`).toBe(value);
        }
        expect(fromScript["@arco-theme"]).toBe(dark ? "dark" : "light");
      });
    }
  }

  it("极端主色也不会发散（首屏与挂载后同一张脸）", () => {
    const extremes = ["#FFFFFF", "#000000", "#FFD400", "#1A1030", "#F0F0F0", "#00FF00", "#FF00FF"];
    for (const primary of extremes) {
      const colors = { primary, accent: "#00B42A" };
      for (const dark of [false, true]) {
        const fromScript = runScript(themeBootstrapScript(), { colors, dark });
        const expected = themeVars(colors, dark);
        // 逐个比对比度感知的派生色：这类值由 ensureContrast 迭代逼近，
        // 公式一旦改岔，最可能先在这里出现肉眼看不出的差异
        for (const key of Object.keys(expected)) {
          expect(fromScript[key], `主色 ${primary}（${dark ? "深色" : "浅色"}）的 ${key}`).toBe(expected[key]);
        }
      }
    }
  });

  it("没有自定义配色时脚本不写任何变量，交还给 CSS 默认值", () => {
    // localStorage 里读不到 colors：这时不该写内联变量，
    // 否则 globals.css 的 :root 默认色会被永久盖住。
    const style: Record<string, string> = {};
    const body = {
      setAttribute: (key: string, value: string) => { style["@" + key] = value; },
      style: { setProperty: (key: string, value: string) => { style[key] = value; }, removeProperty: () => {} },
    };
    const win = {
      localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
      matchMedia: () => ({ matches: false }),
    };
    new Function("window", "document", "__name", themeBootstrapScript())(win, { body, addEventListener: () => {} }, (fn: unknown) => fn);
    expect(Object.keys(style).filter(key => !key.startsWith("@"))).toEqual([]);
    expect(style["@arco-theme"]).toBe("light");
  });

  it("存坏的配色数据不会让首屏脚本写坏变量", () => {
    // JSON 合法但字段缺失/类型错误：normalizeHex 会返回 null，
    // 脚本必须在这种情况下安静退回默认色，而不是把 'null' 之类写进 CSS 变量。
    const stored = JSON.stringify({ primary: "not-a-color", accent: 42 });
    const style: Record<string, string> = {};
    const body = {
      setAttribute: (key: string, value: string) => { style["@" + key] = value; },
      style: { setProperty: (key: string, value: string) => { style[key] = value; }, removeProperty: () => {} },
    };
    const win = {
      localStorage: { getItem: (key: string) => (key === "tuoxin.colors" ? stored : null), setItem: () => {}, removeItem: () => {} },
      matchMedia: () => ({ matches: false }),
    };
    expect(() => {
      new Function("window", "document", "__name", themeBootstrapScript())(win, { body, addEventListener: () => {} }, (fn: unknown) => fn);
    }).not.toThrow();
    expect(Object.keys(style).filter(key => !key.startsWith("@"))).toEqual([]);
  });
});
