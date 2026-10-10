"use client";

import { PageHead } from "./common";
import { ThemeSettings } from "./theme-settings";

export function Settings() {
  return <>
    <PageHead
      eyebrow="Settings"
      title="界面设置"
      copy="自定义管理台配色。改动保存在本机浏览器，只影响当前账号看到的界面。"
    />
    <ThemeSettings />
  </>;
}
