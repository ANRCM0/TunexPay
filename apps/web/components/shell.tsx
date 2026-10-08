"use client";

import { Avatar, Breadcrumb, Drawer, Dropdown, Layout, Menu, Tooltip } from "@arco-design/web-react";
import { IconDown, IconFullscreen, IconMenuFold, IconMenuUnfold, IconMoon, IconSearch, IconSun } from "@arco-design/web-react/icon";
import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { LucideIcon } from "lucide-react";
import { HOME, NAV_GROUPS, matchNavItem, navGroupOf, navTrail, type NavGroup, type NavItem } from "../lib/nav";
import { useNavPush } from "../lib/nav-progress";
import { VersionBadge } from "./version-badge";
import { PageTabs } from "./page-tabs";
import { RouteProgress } from "./route-progress";
// 只取类型：app-version 里含 node:child_process，客户端组件不能把它拉进浏览器包。
import type { AppVersion } from "../lib/app-version";

// 快捷搜索只有用户主动打开时才加载，避免所有管理台页面首屏包含 Modal / 搜索面板代码。
const CommandPalette = dynamic(
  () => import("./command-palette").then(mod => mod.CommandPalette),
  { ssr: false, loading: () => <span className="sr-only" role="status">正在打开快捷搜索</span> },
);

const THEME_KEY = "tuoxin.theme";
const COLLAPSE_KEY = "tuoxin.sider-collapsed";

/**
 * 导航图标统一出口。
 *
 * 图标是纯装饰（文字已经在旁边），所以一律带 aria-hidden；尺寸也从这里统一，
 * 避免各处直接写 <Xxx size={n} /> 时漏掉无障碍属性或写错尺寸。
 */
function NavIcon({ icon: Icon, size }: { icon: LucideIcon; size: number }) {
  return <Icon size={size} aria-hidden="true" />;
}

/** 侧栏导航。桌面放 Sider 里，窄屏放抽屉里，所以抽出来复用一份。 */
function NavMenu({ collapsed, onNavigate }: { collapsed: boolean; onNavigate?: () => void }) {
  const path = usePathname();
  const push = useNavPush();
  const active = matchNavItem(path)?.href ?? HOME.href;
  const group = navGroupOf(path);

  // 默认展开当前所在分组：折叠状态下 Arco 会用弹出层展示子菜单，不需要 openKeys
  const [openKeys, setOpenKeys] = useState<string[]>([]);
  useEffect(() => {
    if (group) setOpenKeys(previous => previous.includes(group.key) ? previous : [...previous, group.key]);
  }, [group]);

  const go = useCallback((href: string) => {
    onNavigate?.();
    push(href);
  }, [onNavigate, push]);

  return <Menu
    className="app-menu"
    mode="vertical"
    collapse={collapsed}
    selectedKeys={[active]}
    openKeys={collapsed ? undefined : openKeys}
    // Arco 的 Menu 没有 onOpenChange，展开/收起靠 onClickSubMenu 自己维护，
    // 这样切到别的分组时能自动把新分组展开。
    onClickSubMenu={collapsed ? undefined : (key: string) => setOpenKeys(previous =>
      previous.includes(key) ? previous.filter(item => item !== key) : [...previous, key],
    )}
    onClickMenuItem={(key: string) => go(key)}
  >
    <Menu.Item key={HOME.href}>
      <span className={`menu-tile tone-${HOME.tone}`}><NavIcon icon={HOME.icon} size={15} /></span>
      <span className="menu-label">{HOME.title}</span>
    </Menu.Item>
    {NAV_GROUPS.map((item: NavGroup) => (
      <Menu.SubMenu
        key={item.key}
        title={<span className="menu-group-title">
          <span className={`menu-tile tone-${item.tone}`}><NavIcon icon={item.icon} size={15} /></span>
          <span className="menu-label">{item.title}</span>
        </span>}
      >
        {item.items.map((child: NavItem) => (
          // 二级项不放进色块，改用固定宽度的图标盒：图标列与文字列才能逐行对齐
          <Menu.Item key={child.href} className={`nav-tone-${child.tone}`}>
            <span className="menu-icon"><NavIcon icon={child.icon} size={16} /></span>
            <span className="menu-label">{child.title}</span>
          </Menu.Item>
        ))}
      </Menu.SubMenu>
    ))}
  </Menu>;
}

function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(false);
  useEffect(() => {
    const list = window.matchMedia(query);
    setMatches(list.matches);
    const onChange = (event: MediaQueryListEvent) => setMatches(event.matches);
    list.addEventListener("change", onChange);
    return () => list.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

export function Shell({ children, version }: { children: React.ReactNode; version: AppVersion }) {
  const path = usePathname();
  const isNarrow = useMediaQuery("(max-width: 980px)");
  const [collapsed, setCollapsed] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [dark, setDark] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

  // 折叠与主题都是“下次进来还想保持”的偏好，首帧先按默认值渲染再读存储，
  // 否则服务端渲染出的 HTML 与客户端不一致。
  useEffect(() => {
    try {
      setCollapsed(window.localStorage.getItem(COLLAPSE_KEY) === "1");
      const stored = window.localStorage.getItem(THEME_KEY);
      const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
      setDark(stored ? stored === "dark" : prefersDark);
    } catch { /* 隐私模式下读不到，保持默认 */ }
  }, []);

  useEffect(() => {
    document.body.setAttribute("arco-theme", dark ? "dark" : "light");
    try { window.localStorage.setItem(THEME_KEY, dark ? "dark" : "light"); } catch { /* 同上 */ }
  }, [dark]);

  useEffect(() => {
    try { window.localStorage.setItem(COLLAPSE_KEY, collapsed ? "1" : "0"); } catch { /* 同上 */ }
  }, [collapsed]);

  useEffect(() => { setNavOpen(false); }, [path]);

  // 路由切换后回到顶部。管理台页面很长（对账、MCP、通知），而从客户端路由跳转不会重置
  // 滚动位置，用户点侧栏后会落在新页面的中间，看起来像"页面没反应"。
  // 滚动发生在文档根上：.app-content 没有 overflow，不是滚动容器。
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [path]);

  // Ctrl/Cmd + K 唤起命令面板；两个修饰键都支持，macOS 用户按 Cmd，其它平台按 Ctrl
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen(value => !value);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const trail = useMemo(() => navTrail(path), [path]);

  return <Layout className={isNarrow ? "app-shell narrow" : "app-shell"}>
    <RouteProgress />
    <Layout.Sider
      className="app-sider"
      theme="light"
      width={220}
      collapsedWidth={48}
      collapsed={collapsed}
      trigger={null}
    >
      <div className={isNarrow || !collapsed ? "brand" : "brand collapsed"}>
        <span className="brand-mark" aria-hidden="true">T</span>
        <span className="brand-text">
          <span className="brand-title">TUOXIN PAY</span>
          <span className="brand-subtitle">拓昕支付基础设施</span>
        </span>
      </div>
      <div className="sider-nav"><NavMenu collapsed={isNarrow ? true : collapsed} /></div>
      <div className="sidebar-foot"><VersionBadge initial={version} /></div>
    </Layout.Sider>

    <Layout className="app-main">
      <Layout.Header className="app-header">
        <button
          type="button"
          className="header-icon"
          onClick={() => (isNarrow ? setNavOpen(true) : setCollapsed(value => !value))}
          aria-label={isNarrow ? "打开导航菜单" : collapsed ? "展开侧边栏" : "折叠侧边栏"}
          aria-expanded={isNarrow ? navOpen : !collapsed}
        >
          {(isNarrow || collapsed) ? <IconMenuUnfold style={{ fontSize: 18 }} aria-hidden="true" /> : <IconMenuFold style={{ fontSize: 18 }} aria-hidden="true" />}
        </button>

        <Breadcrumb className="app-breadcrumb">
          {trail.map(item => <Breadcrumb.Item key={item}>{item}</Breadcrumb.Item>)}
        </Breadcrumb>

        <div className="header-actions">
          <Tooltip content="搜索页面 (Ctrl+K)">
            <button type="button" className="header-icon" onClick={() => setPaletteOpen(true)} aria-label="搜索页面">
              <IconSearch style={{ fontSize: 17 }} aria-hidden="true" />
            </button>
          </Tooltip>
          <Tooltip content={dark ? "切换为浅色" : "切换为深色"}>
            <button type="button" className="header-icon" onClick={() => setDark(value => !value)} aria-label={dark ? "切换为浅色主题" : "切换为深色主题"}>
              {dark ? <IconSun style={{ fontSize: 17 }} aria-hidden="true" /> : <IconMoon style={{ fontSize: 17 }} aria-hidden="true" />}
            </button>
          </Tooltip>
          <Tooltip content="全屏">
            <button type="button" className="header-icon" onClick={() => void toggleFullscreen()} aria-label="切换全屏">
              <IconFullscreen style={{ fontSize: 17 }} aria-hidden="true" />
            </button>
          </Tooltip>
          <Dropdown droplist={<Menu onClickMenuItem={(key: string) => { if (key === "logout") void logout(); }}>
            <Menu.Item key="logout">退出登录</Menu.Item>
          </Menu>} position="br">
            <button type="button" className="header-user" aria-label="账号菜单">
              <Avatar size={28} className="header-avatar" aria-hidden="true">管</Avatar>
              <span className="header-name">系统管理员</span>
              <IconDown style={{ fontSize: 12 }} aria-hidden="true" />
            </button>
          </Dropdown>
        </div>
      </Layout.Header>

      <PageTabs path={path} />

      <Layout.Content className="app-content">{children}</Layout.Content>

      <Layout.Footer className="app-footer">TUOXIN PAY · 单租户支付基础设施</Layout.Footer>
    </Layout>

    <Drawer
      className="nav-drawer"
      width={230}
      title={<span className="nav-drawer-title"><span className="brand-mark" aria-hidden="true">T</span> TUOXIN PAY</span>}
      visible={navOpen}
      onCancel={() => setNavOpen(false)}
      footer={null}
      placement="left"
    >
      <NavMenu collapsed={false} onNavigate={() => setNavOpen(false)} />
    </Drawer>

    {paletteOpen && <CommandPalette open onClose={() => setPaletteOpen(false)} />}
  </Layout>;
}

async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch {
    // 某些浏览器/权限策略下全屏会被拒绝，不影响其它功能
  }
}

async function logout() {
  await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
  window.location.assign("/login");
}
