"use client";

import { Dropdown, Menu } from "@arco-design/web-react";
import { IconClose, IconRefresh } from "@arco-design/web-react/icon";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { matchNavItem } from "../lib/nav";
import { useNavPush } from "../lib/nav-progress";
import { refreshClientData } from "../lib/refresh";
import { closeAll, closeOthers, closeTab, HOME_TAB, loadTabs, openTab, saveTabs, type Tab } from "../lib/tabs";

/**
 * MPAY / SnowAdmin 式的多页签栏。
 *
 * 页签只记顶层菜单页：进入 /orders/PAY123 这类详情页时，仍然激活「支付订单」
 * 页签，避免点一次详情就多出一个页签。页签内容不缓存（Next 的路由缓存负责），
 * 这里只管标签本身。
 */
export function PageTabs({ path }: { path: string }) {
  const push = useNavPush();
  const router = useRouter();
  const [tabs, setTabs] = useState<Tab[]>([HOME_TAB]);
  const hydrated = useRef(false);

  const current = useMemo(() => matchNavItem(path), [path]);
  const activeHref = current?.href ?? HOME_TAB.href;

  // 首帧先用默认值渲染，挂载后再读 localStorage：服务端没有 localStorage，
  // 直接读会让首屏 HTML 与客户端不一致。
  useEffect(() => {
    if (hydrated.current) return;
    hydrated.current = true;
    setTabs(loadTabs());
  }, [activeHref]);

  // 路由变化：把当前菜单页开成页签并激活它
  useEffect(() => {
    if (!current) return;
    setTabs(previous => openTab(previous, { href: current.href, title: current.title }));
  }, [current]);

  useEffect(() => {
    if (hydrated.current) saveTabs(tabs);
  }, [tabs]);

  const gotoTab = useCallback((href: string) => {
    if (href !== path) push(href);
  }, [path, push]);

  const close = useCallback((href: string) => {
    const result = closeTab(tabs, href, activeHref);
    setTabs(result.tabs);
    if (result.active !== activeHref) push(result.active);
  }, [tabs, activeHref, push]);

  const closeOthersThan = useCallback((href: string) => {
    setTabs(previous => {
      const result = closeOthers(previous, href, activeHref);
      return result.tabs;
    });
  }, [activeHref]);

  const closeThemAll = useCallback(() => {
    const result = closeAll();
    setTabs(result.tabs);
    if (result.active !== path) push(result.active);
  }, [path, push]);

  const refresh = useCallback(() => {
    // router.refresh() 只更新服务端组件，业务数据来自 useApi；两层都需要刷新。
    refreshClientData();
    router.refresh();
  }, [router]);

  // 只滚动页签容器，不能 scrollIntoView：它还可能把整张管理台页面带着滚动。
  const tabsListRef = useRef<HTMLDivElement | null>(null);
  const activeRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const list = tabsListRef.current;
    const selected = activeRef.current;
    if (!list || !selected) return;
    const viewport = list.getBoundingClientRect();
    const item = selected.getBoundingClientRect();
    if (item.left < viewport.left) list.scrollLeft -= viewport.left - item.left + 8;
    else if (item.right > viewport.right) list.scrollLeft += item.right - viewport.right + 8;
  }, [activeHref, tabs.length]);

  // WAI-ARIA tabs：方向键、Home、End 操作页签；切换后移动焦点，关闭按钮保留独立焦点入口。
  const onTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, href: string) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const index = Math.max(0, tabs.findIndex(tab => tab.href === href));
    const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1
      : event.key === "ArrowRight" ? (index + 1) % tabs.length
      : (index - 1 + tabs.length) % tabs.length;
    tabsListRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
    gotoTab(tabs[next].href);
  };

  return <div className="page-tabs" aria-label="已打开的页面">
    <div className="page-tabs-list" role="tablist" aria-label="已打开的页面" ref={tabsListRef}>
      {tabs.map(tab => {
        const isActive = tab.href === activeHref;
        return <Dropdown
          key={tab.href}
          trigger="contextMenu"
          position="bl"
          droplist={<Menu onClickMenuItem={(key) => {
            if (key === "refresh") refresh();
            else if (key === "close") close(tab.href);
            else if (key === "others") closeOthersThan(tab.href);
            else if (key === "all") closeThemAll();
          }}>
            <Menu.Item key="refresh" disabled={!isActive}><IconRefresh aria-hidden="true" /> 刷新当前</Menu.Item>
            <Menu.Item key="close" disabled={tab.href === HOME_TAB.href}><IconClose aria-hidden="true" /> 关闭当前</Menu.Item>
            <Menu.Item key="others">关闭其它</Menu.Item>
            <Menu.Item key="all">关闭全部</Menu.Item>
          </Menu>}
        >
          <div className={isActive ? "page-tab-entry active" : "page-tab-entry"} ref={isActive ? activeRef : undefined}>
            <button
              type="button"
              role="tab"
              aria-selected={isActive}
              tabIndex={isActive ? 0 : -1}
              className={isActive ? "page-tab active" : "page-tab"}
              onClick={() => gotoTab(tab.href)}
              onKeyDown={(event) => onTabKeyDown(event, tab.href)}
              onAuxClick={(event) => { if (event.button === 1 && tab.href !== HOME_TAB.href) close(tab.href); }}
            >
              <span className="page-tab-text">{tab.title}</span>
            </button>
            {tab.href !== HOME_TAB.href && <button
              type="button"
              className="page-tab-close"
              aria-label={`关闭 ${tab.title}`}
              title={`关闭 ${tab.title}`}
              onClick={() => close(tab.href)}
            ><IconClose aria-hidden="true" /></button>}
          </div>
        </Dropdown>;
      })}
    </div>
    <div className="page-tabs-actions">
      <button type="button" className="page-tabs-action" onClick={refresh} aria-label="刷新当前页" title="刷新当前页"><IconRefresh aria-hidden="true" /></button>
      <button type="button" className="page-tabs-action" onClick={closeThemAll} aria-label="关闭全部页签" title="关闭全部页签"><IconClose aria-hidden="true" /></button>
    </div>
  </div>;
}
