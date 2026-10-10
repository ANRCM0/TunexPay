"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { Check, RotateCcw } from "lucide-react";
import { Section, Toast } from "./common";
import {
  DEFAULT_COLORS, PRESETS, applyColors, getColors, isCustomized, normalizeHex,
  setColors, subscribeColors, type ThemeColors,
} from "../lib/theme";

/**
 * 配色设置面板。
 *
 * 只让用户改两个「源头色」，其余派生色由 lib/theme.ts 现算，
 * 所以这里不需要（也不应该）暴露 hover / soft 之类的中间变量，
 * 否则用户配出前后矛盾的组合，还得逐个校验。
 *
 * 实时预览：改色立刻写到 <html> 内联变量上，所见即所得；
 * 「恢复默认」清掉存储回到出厂配色。
 */
export function ThemeSettings() {
  const colors = useSyncExternalStore(subscribeColors, getColors, () => DEFAULT_COLORS);
  const [toast, setToast] = useState<string | null>(null);
  const [dark, setDark] = useState(false);

  // 暗色模式下柔和底 / hover 的算法不同，改色时要按当前模式重算
  useEffect(() => {
    const read = () => setDark(document.body.getAttribute("arco-theme") === "dark");
    read();
    const observer = new MutationObserver(read);
    observer.observe(document.body, { attributes: true, attributeFilter: ["arco-theme"] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => { applyColors(colors, dark); }, [colors, dark]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 2400);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const update = useCallback((patch: Partial<ThemeColors>) => {
    setColors({ ...getColors(), ...patch });
  }, []);

  const reset = useCallback(() => {
    setColors(null);
    setToast("已恢复默认配色");
  }, []);

  const customized = isCustomized(colors);

  return <>
    <Section
      title="界面配色"
      action={customized
        ? <button type="button" className="button secondary" onClick={reset}>
            <RotateCcw size={14} aria-hidden="true" /> 恢复默认
          </button>
        : undefined}
    >
      <p className="settings-group-head p theme-intro">
        主色用于按钮、链接和选中态；强调色用于品牌标记、成功状态和侧栏高亮。
        改动立即生效并保存在本机浏览器，不影响其他账号。
      </p>

      <fieldset className="settings-group theme-fieldset">
        <legend className="sr-only">自定义颜色</legend>

        <ColorField
          label="主色"
          hint="按钮、链接、输入框焦点、选中态"
          value={colors.primary}
          fallback={DEFAULT_COLORS.primary}
          onChange={value => update({ primary: value })}
        />
        <ColorField
          label="强调色"
          hint="品牌渐变、成功状态、侧栏选中标记"
          value={colors.accent}
          fallback={DEFAULT_COLORS.accent}
          onChange={value => update({ accent: value })}
        />
      </fieldset>

      <div className="theme-preview" aria-hidden="true">
        <span className="theme-preview-label">效果预览</span>
        <button type="button" className="button" tabIndex={-1}>主色按钮</button>
        <button type="button" className="button-accent" tabIndex={-1}>强调色按钮</button>
        <span className="badge badge-success">成功</span>
        <span className="theme-preview-swatch" style={{ background: colors.primary }} />
        <span className="theme-preview-swatch" style={{ background: colors.accent }} />
      </div>

      <div className="theme-presets">
        <span className="theme-presets-label">预设方案</span>
        <div className="theme-presets-list">
          {PRESETS.map(preset => {
            const active = normalizeHex(preset.colors.primary) === colors.primary
              && normalizeHex(preset.colors.accent) === colors.accent;
            return <button
              key={preset.name}
              type="button"
              className={active ? "theme-preset active" : "theme-preset"}
              aria-pressed={active}
              onClick={() => { setColors(preset.colors); setToast(`已应用「${preset.name}」`); }}
            >
              <span className="theme-preset-dots" aria-hidden="true">
                <i style={{ background: preset.colors.primary }} />
                <i style={{ background: preset.colors.accent }} />
              </span>
              {preset.name}
              {active && <Check size={13} aria-hidden="true" />}
            </button>;
          })}
        </div>
      </div>
    </Section>

    {toast && <Toast type="ok" text={toast} onClose={() => setToast(null)} />}
  </>;
}

/**
 * 单个颜色输入。
 *
 * 原生取色器负责挑色，文本框负责精确输入（取色器在小屏或精确取值时不好用）。
 * 文本框只在失焦或回车时提交，否则用户删到一半（`#6A5`）就会触发一次无效重算。
 */
function ColorField({ label, hint, value, fallback, onChange }: {
  label: string;
  hint: string;
  value: string;
  fallback: string;
  onChange: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [invalid, setInvalid] = useState(false);

  useEffect(() => { setDraft(value); setInvalid(false); }, [value]);

  function commit() {
    const normalized = normalizeHex(draft);
    if (!normalized) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    setDraft(normalized);
    if (normalized !== value) onChange(normalized);
  }

  return <label className="theme-field">
    <span className="theme-field-label">{label}</span>
    <span className="theme-field-control">
      <input
        type="color"
        className="theme-color-input"
        value={value}
        aria-label={`${label}取色器`}
        onChange={event => onChange(normalizeHex(event.target.value) ?? fallback)}
      />
      <input
        type="text"
        className={invalid ? "theme-hex-input invalid" : "theme-hex-input"}
        value={draft}
        spellCheck={false}
        maxLength={7}
        aria-label={`${label}色值`}
        aria-invalid={invalid}
        onChange={event => { setDraft(event.target.value); setInvalid(false); }}
        onBlur={commit}
        onKeyDown={event => {
          if (event.key === "Enter") { event.preventDefault(); commit(); }
          if (event.key === "Escape") { setDraft(value); setInvalid(false); }
        }}
      />
    </span>
    <span className={invalid ? "theme-field-hint error" : "theme-field-hint"}>
      {invalid ? "请输入合法的十六进制色值，例如 #6A5FC1" : hint}
    </span>
  </label>;
}
