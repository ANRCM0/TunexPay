import { describe, expect, it } from "vitest";
import { deriveVars, themeBootstrapScript, DEFAULT_COLORS, PRESETS } from "./theme";

/* ------------------------------------------------------------------ *
 * 对比度工具（与 lib/theme.ts 内部实现独立，用于交叉验证）
 * ------------------------------------------------------------------ */

function hexToRgb(hex: string): [number, number, number] {
  let h = hex.replace("#", "");
  if (h.length === 3) h = h.split("").map(c => c + c).join("");
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map(v => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/* ------------------------------------------------------------------ *
 * 引导脚本完整性
 *
 * themeBootstrapScript() 把纯函数 toString() 后拼成内联脚本。
 * 若 deriveVars 依赖的函数没被序列化进去，浏览器里会抛 ReferenceError，
 * 而脚本外层 try/catch 会静默吞掉 —— 表现为「自定义配色保存了但不生效」，
 * 控制台零报错。这组测试专门防住这类回归。
 * ------------------------------------------------------------------ */

describe("themeBootstrapScript 完整性", () => {
  const script = themeBootstrapScript();

  it("序列化了 deriveVars 依赖的全部函数", () => {
    const defined = new Set(
      [...script.matchAll(/function\s+(\w+)\s*\(/g)].map(m => m[1])
    );
    const required = [
      "hexToRgb", "normalizeHex", "clamp", "rgbToHex", "mix",
      "luminance", "onColor", "contrast", "ensureContrast",
      "rgbParts", "soft", "deriveVars",
    ];
    const absent = required.filter(fn => !defined.has(fn));
    expect(absent, `缺少序列化的函数: ${absent.join(", ")}`).toEqual([]);
  });

  it("不引用任何未定义的标识符", () => {
    const defined = new Set(
      [...script.matchAll(/function\s+(\w+)\s*\(/g)].map(m => m[1])
    );
    for (const m of script.matchAll(/\b(?:var|let|const)\s+(\w+)/g)) defined.add(m[1]);

    const whitelist = new Set([
      "if", "for", "function", "return", "try", "catch", "var", "let", "const",
      "else", "while", "new", "typeof", "in", "of", "this", "null", "true", "false",
      "JSON", "Object", "Array", "Math", "String", "Number", "Boolean", "parseInt",
      "parseFloat", "isNaN", "RegExp", "window", "document", "localStorage",
      "matchMedia", "toString", "trim", "exec", "slice", "split", "map", "join",
      "padStart", "min", "max", "round", "pow", "abs", "stringify", "parse",
      "assign", "getItem", "setItem", "removeItem", "setAttribute", "getAttribute",
      "setProperty", "removeProperty", "getPropertyValue", "addEventListener",
      "hasOwnProperty", "forEach", "filter", "reduce", "push", "concat",
      "toUpperCase", "toLowerCase", "charAt", "indexOf", "replace", "match",
      "matchAll", "keys", "values", "entries", "from", "isArray", "now", "paint",
    ]);

    const called = [...script.matchAll(/(?:^|[^.\w])(\w+)\s*\(/g)].map(m => m[1]);
    const missing = [...new Set(called)].filter(n => !defined.has(n) && !whitelist.has(n));
    expect(missing, `未定义的标识符: ${missing.join(", ")}`).toEqual([]);
  });

  it("执行后能真正写入自定义配色（端到端冒烟）", () => {
    const store: Record<string, string> = {
      "tuoxin.colors": JSON.stringify({ primary: "#FFD400", accent: "#00B42A" }),
      "tuoxin.theme": "dark",
    };
    const style: Record<string, string> = {};
    const body = {
      setAttribute: (k: string, v: string) => { style["@" + k] = v; },
      style: {
        setProperty: (k: string, v: string) => { style[k] = v; },
        removeProperty: (k: string) => { delete style[k]; },
      },
    };
    const win = {
      localStorage: {
        getItem: (k: string) => store[k] ?? null,
        setItem: (k: string, v: string) => { store[k] = v; },
        removeItem: (k: string) => { delete store[k]; },
      },
      matchMedia: () => ({ matches: false }),
    };

    // __name 是某些打包器 keepNames 转换注入的辅助函数，真实 SWC 构建没有；
    // 传 identity 版本让冒烟测试在测试环境下也能真实跑完 deriveVars。
    new Function("window", "document", "__name", script)(win, { body, addEventListener: () => {} }, (fn: unknown) => fn);

    expect(style["--primary"]).toBe("#FFD400");
    expect(style["--primary-text"], "--primary-text 应随主色派生").toBeTruthy();
    expect(style["--accent-green"]).toBe("#00B42A");
    expect(style["@arco-theme"]).toBe("dark");
  });
});

/* ------------------------------------------------------------------ *
 * 对比度感知派生
 * ------------------------------------------------------------------ */

describe("deriveVars 对比度", () => {
  const LIGHT_BGS = ["#FFFFFF", "#F7F8FA", "#F2F3F5"];
  const DARK_BGS = ["#1F1633", "#150F23"];

  it("默认主色的 --primary-text 在浅色下全部达到 AA", () => {
    const v = deriveVars(DEFAULT_COLORS.primary, "primary", false);
    for (const bg of LIGHT_BGS) {
      expect(
        contrast(v["--primary-text"], bg),
        `${v["--primary-text"]} on ${bg}`
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("默认主色的 --primary-text 在深色下全部达到 AA", () => {
    const v = deriveVars(DEFAULT_COLORS.primary, "primary", true);
    for (const bg of DARK_BGS) {
      expect(
        contrast(v["--primary-text"], bg),
        `${v["--primary-text"]} on ${bg}`
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("任意主色都能派生出达标的文字色（极端值）", () => {
    const extremes = [
      "#FFFFFF", "#000000", "#FFD400", "#1A1030", "#F0F0F0", "#00FF00", "#FF00FF",
    ];
    for (const primary of extremes) {
      for (const dark of [false, true]) {
        const v = deriveVars(primary, "primary", dark);
        const softBg = v["--primary-soft"];
        const bgs = [...(dark ? DARK_BGS : LIGHT_BGS), softBg];
        for (const bg of bgs) {
          const r = contrast(v["--primary-text"], bg);
          expect(
            r,
            `主色 ${primary}（${dark ? "深色" : "浅色"}）派生出 ${v["--primary-text"]}，在 ${bg} 上仅 ${r.toFixed(2)}`
          ).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });

  it("所有预设配色都达标", () => {
    for (const preset of PRESETS) {
      for (const dark of [false, true]) {
        const v = deriveVars(preset.colors.primary, "primary", dark);
        const bgs = [...(dark ? DARK_BGS : LIGHT_BGS), v["--primary-soft"]];
        for (const bg of bgs) {
          expect(
            contrast(v["--primary-text"], bg),
            `预设「${preset.name}」在 ${bg} 上不达标`
          ).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });

  it("--primary-text 不改变主色本身（按钮背景仍用原色）", () => {
    // 用一个在深色底上【不达标】的主色，才能观察到文字色被调整
    const v = deriveVars("#1A1030", "primary", true);
    expect(v["--primary"]).toBe("#1A1030");
    expect(v["--primary-text"]).not.toBe("#1A1030");
    expect(contrast(v["--primary-text"], "#1F1633")).toBeGreaterThanOrEqual(4.5);
  });

  it("本来就达标的主色，其文字色保持原值", () => {
    // #FFD400 在深色底上对比度 12+，无需调整
    const v = deriveVars("#FFD400", "primary", true);
    expect(v["--primary-text"]).toBe("#FFD400");
  });

  it("非主色的前缀不产生 -text 变量", () => {
    const v = deriveVars("#00B42A", "accent-green", false);
    expect(v["--accent-green-text"]).toBeUndefined();
  });
});
