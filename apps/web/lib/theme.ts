/**
 * 主题配色引擎。
 *
 * 管理台只暴露两个「源头色」：主色（primary）和强调色（accent）。
 * 其余派生色（hover / active / soft / 文字反色 / RGB 分量）都在这里算出来，
 * 以 CSS 变量的形式写到 <html> 上，页面样式只管读变量，不关心用户选了什么。
 *
 * 为什么不用现成的主题库：管理台的配色已经全部收敛到 CSS 变量，
 * 这里只需要把变量重算一遍即可，引入库反而要改动现有样式层。
 */

export type ThemeColors = {
  /** 主色：按钮、链接、选中态、焦点环 */
  primary: string;
  /** 强调色：品牌渐变、成功态、侧栏选中标记 */
  accent: string;
};

export const DEFAULT_COLORS: ThemeColors = {
  primary: "#6A5FC1",
  accent: "#00B42A",
};

/** 预设配色。第一项是项目默认色，用户改坏了可以一键回到这里。 */
export const PRESETS: { name: string; colors: ThemeColors }[] = [
  { name: "拓昕紫", colors: { primary: "#6A5FC1", accent: "#00B42A" } },
  { name: "翡翠绿", colors: { primary: "#0E9F6E", accent: "#3F83F8" } },
  { name: "深海蓝", colors: { primary: "#2563EB", accent: "#F59E0B" } },
  { name: "暮山橙", colors: { primary: "#EA6A2A", accent: "#2563EB" } },
  { name: "玫瑰红", colors: { primary: "#E11D63", accent: "#8B5CF6" } },
  { name: "石墨灰", colors: { primary: "#4B5563", accent: "#0E9F6E" } },
];

const STORAGE_KEY = "tuoxin.colors";

/* ------------------------------------------------------------------ *
 * 颜色计算
 * ------------------------------------------------------------------ */

type RGB = { r: number; g: number; b: number };

export function hexToRgb(hex: string): RGB | null {
  const matched = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!matched) return null;
  let body = matched[1];
  if (body.length === 3) body = body.split("").map(char => char + char).join("");
  return {
    r: parseInt(body.slice(0, 2), 16),
    g: parseInt(body.slice(2, 4), 16),
    b: parseInt(body.slice(4, 6), 16),
  };
}

export function isValidHex(hex: string): boolean {
  return hexToRgb(hex) !== null;
}

function clamp(value: number): number {
  return Math.round(Math.min(255, Math.max(0, value)));
}

function rgbToHex({ r, g, b }: RGB): string {
  return `#${[r, g, b].map(channel => clamp(channel).toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}

/** 把 a 向 b 混合，weight 是 b 的占比（0 = 全是 a，1 = 全是 b）。 */
function mix(a: string, b: string, weight: number): string {
  const from = hexToRgb(a);
  const to = hexToRgb(b);
  if (!from || !to) return a;
  return rgbToHex({
    r: from.r + (to.r - from.r) * weight,
    g: from.g + (to.g - from.g) * weight,
    b: from.b + (to.b - from.b) * weight,
  });
}

/** 相对亮度（WCAG），用来判断底色上该配白字还是黑字。 */
function luminance(hex: string): number {
  const rgb = hexToRgb(hex);
  if (!rgb) return 0;
  const channel = (value: number) => {
    const ratio = value / 255;
    return ratio <= 0.03928 ? ratio / 12.92 : Math.pow((ratio + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
}

/** 底色上的可读文字色：亮底配深字，暗底配白字。 */
function onColor(hex: string): string {
  return luminance(hex) > 0.55 ? "#1D2129" : "#FFFFFF";
}

function rgbParts(hex: string): string {
  const rgb = hexToRgb(hex);
  return rgb ? `${rgb.r}, ${rgb.g}, ${rgb.b}` : "0, 0, 0";
}

/** 把颜色揉进面板底色，得到低饱和的「柔和」变体（用于浅底标签、选中态背景）。 */
function soft(hex: string, dark: boolean): string {
  return dark ? mix(hex, "#1F1633", 0.76) : mix(hex, "#FFFFFF", 0.9);
}

/**
 * 由一个源头色算出整套派生变量。
 * 深浅模式分开算：暗色模式下 hover 要往亮处提，柔和底要往深面板里压。
 */
export function deriveVars(hex: string, prefix: string, dark: boolean): Record<string, string> {
  const lift = dark ? 0.22 : 0.16;
  return {
    [`--${prefix}`]: hex,
    [`--${prefix}-hover`]: mix(hex, dark ? "#FFFFFF" : "#FFFFFF", lift),
    [`--${prefix}-active`]: mix(hex, "#000000", dark ? 0.18 : 0.22),
    [`--${prefix}-soft`]: soft(hex, dark),
    [`--${prefix}-rgb`]: rgbParts(hex),
    [`--on-${prefix}`]: onColor(hex),
  };
}

/** 一次算出主色 + 强调色的全部变量。 */
export function themeVars(colors: ThemeColors, dark: boolean): Record<string, string> {
  return {
    ...deriveVars(colors.primary, "primary", dark),
    ...deriveVars(colors.accent, "accent-green", dark),
  };
}

/** 规范化用户输入：容错 `abc` / `#abc` / `AABBCC`，失败返回 null。 */
export function normalizeHex(input: string): string | null {
  const rgb = hexToRgb(input);
  return rgb ? rgbToHex(rgb) : null;
}

/* ------------------------------------------------------------------ *
 * 状态与持久化
 * ------------------------------------------------------------------ */

let current: ThemeColors | null = null;
const listeners = new Set<() => void>();

function sanitize(value: unknown): ThemeColors | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<ThemeColors>;
  const primary = typeof candidate.primary === "string" ? normalizeHex(candidate.primary) : null;
  const accent = typeof candidate.accent === "string" ? normalizeHex(candidate.accent) : null;
  if (!primary || !accent) return null;
  return { primary, accent };
}

/** 读取用户配色；没存过或存坏了都返回默认色。 */
export function getColors(): ThemeColors {
  if (current) return current;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = sanitize(JSON.parse(raw));
      if (parsed) {
        current = parsed;
        return parsed;
      }
    }
  } catch { /* 隐私模式 / 脏数据：落到默认色 */ }
  return DEFAULT_COLORS;
}

/** 是否偏离了默认配色（用来决定要不要显示「恢复默认」）。 */
export function isCustomized(colors: ThemeColors): boolean {
  return normalizeHex(colors.primary) !== DEFAULT_COLORS.primary
    || normalizeHex(colors.accent) !== DEFAULT_COLORS.accent;
}

/**
 * 保存配色并广播。
 * 传 null 表示恢复默认：清掉存储，回到出厂配色。
 */
export function setColors(colors: ThemeColors | null): ThemeColors {
  const next = colors ? (sanitize(colors) ?? DEFAULT_COLORS) : null;
  current = next;
  try {
    if (next) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch { /* 存不下不影响本次会话生效 */ }
  listeners.forEach(listener => listener());
  return next ?? DEFAULT_COLORS;
}

export function subscribeColors(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/**
 * 把配色写到内联样式上。
 *
 * 为什么写在 <body> 而不是 <html>：暗色变量定义在 `[arco-theme="dark"]` 选择器上，
 * 而 `arco-theme` 属性挂在 <body>，所以 body 上的声明比 html 上的更近、优先级更高。
 * 写到 html 会被暗色块盖掉 —— 表现为「浅色模式能改色，切到深色就变回默认紫」。
 *
 * 用内联样式是因为它优先级高于 `:root` 和 `[arco-theme="dark"]`，
 * 不需要为「用户自定义」再写一套选择器。代价是深浅模式切换时必须重算一次
 * （柔和底和 hover 的算法不同），所以调用方要在主题变化时重新执行。
 */
function themeHost(): HTMLElement {
  return document.body ?? document.documentElement;
}

export function applyColors(colors: ThemeColors, dark: boolean): void {
  const host = themeHost();
  const vars = themeVars(colors, dark);
  for (const [name, value] of Object.entries(vars)) host.style.setProperty(name, value);
}

/** 清掉内联变量，交还给 CSS 里的默认值。 */
export function clearAppliedColors(): void {
  const host = themeHost();
  for (const name of Object.keys(themeVars(DEFAULT_COLORS, false))) host.style.removeProperty(name);
}

/* ------------------------------------------------------------------ *
 * 首屏引导
 * ------------------------------------------------------------------ */

export const THEME_MODE_KEY = "tuoxin.theme";

/**
 * 生成一段阻塞式内联脚本，在首帧绘制前把主题模式和自定义配色写上去。
 *
 * 为什么必须内联：Shell 里的主题是在 useEffect 里设置的，那时浏览器已经画完第一帧，
 * 深色模式用户会看到一闪而过的白屏；自定义配色同理。内联脚本在 <head> 里同步执行，
 * 早于任何绘制。
 *
 * 配色算法不在这里重写一遍 —— 直接把上面的纯函数序列化进脚本，
 * 保证浏览器首屏用的公式和运行时用的完全一致，不会两边改着改着就对不上。
 */
export function themeBootstrapScript(): string {
  const helpers = [hexToRgb, normalizeHex, clamp, rgbToHex, mix, luminance, onColor, rgbParts, soft, deriveVars]
    .map(fn => fn.toString())
    .join("\n");

  return `(function(){try{
${helpers}
var MODE_KEY=${JSON.stringify(THEME_MODE_KEY)},COLOR_KEY=${JSON.stringify(STORAGE_KEY)};
var mode=null;
try{mode=window.localStorage.getItem(MODE_KEY);}catch(e){}
var dark=mode?mode==="dark":window.matchMedia("(prefers-color-scheme: dark)").matches;
function paint(){
var body=document.body;if(!body)return;
body.setAttribute("arco-theme",dark?"dark":"light");
var raw=null;
try{raw=window.localStorage.getItem(COLOR_KEY);}catch(e){}
if(!raw)return;
var parsed=JSON.parse(raw);
var primary=normalizeHex(parsed&&parsed.primary),accent=normalizeHex(parsed&&parsed.accent);
if(!primary||!accent)return;
var vars=Object.assign(deriveVars(primary,"primary",dark),deriveVars(accent,"accent-green",dark));
for(var name in vars)body.style.setProperty(name,vars[name]);
}
// 变量必须落在 <body>：暗色变量定义在 [arco-theme="dark"] 上，而该属性挂在 body，
// 写到 <html> 会被暗色块覆盖，表现为「切到深色就变回默认色」。
if(document.body)paint();else document.addEventListener("DOMContentLoaded",paint);
}catch(e){}})();`;
}
