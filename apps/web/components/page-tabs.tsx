"use client";

import { Dropdown, Menu } from "@arco-design/web-react";
import { IconClose, IconRefresh } from "@arco-design/web-react/icon";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { matchNavItem } from "../lib/nav";
import { useNavPush } from "../lib/nav-progress";
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
  const [active, setActive] = useState<string>(HOME_TAB.href);
  const hydrated = useRef(false);

  const current = useMemo(() => matchNavItem(path), [path]);
  const activeHref = current?.href ?? HOME_TAB.href;

  // 首帧先用默认值渲染，挂载后再读 localStorage：服务端没有 localStorage，
  // 直接读会让首屏 HTML 与客户端不一致。
  useEffect(() => {
    if (hydrated.current) return;
    hydrated.current = true;
    setTabs(loadTabs());
    setActive(activeHref);
  }, [activeHref]);

  // 路由变化：把当前菜单页开成页签并激活它
  useEffect(() => {
    if (!current) {
      setActive(HOME_TAB.href);
      return;
    }
    setTabs(previous => openTab(previous, { href: current.href, title: current.title }));
    setActive(current.href);
  }, [current]);

  useEffect(() => {
    if (hydrated.current) saveTabs(tabs);
  }, [tabs]);

  const gotoTab = useCallback((href: string) => {
    setActive(href);
    push(href);
  }, [router]);

  const close = useCallback((href: string) => {
    setTabs(previous => {
      const result = closeTab(previous, href, activeHref);
      if (result.active !== activeHref) {
        setActive(result.active);
        push(result.active);
      }
      return result.tabs;
    });
  }, [activeHref, router]);

  const closeOthersThan = useCallback((href: string) => {
    setTabs(previous => {
      const result = closeOthers(previous, href, activeHref);
      return result.tabs;
    });
  }, [activeHref]);

  const closeThemAll = useCallback(() => {
    const result = closeAll();
    setTabs(result.tabs);
    setActive(result.active);
    push(result.active);
  }, [router]);

  const refresh = useCallback(() => {
    router.refresh();
  }, [router]);

  // 页签会被动累积（每访问一个菜单就多一个），数量超过一行宽度后，新激活的页签会落在
  // 可视区之外——用户点完菜单却看不到自己在哪里。切换时把它滚进视野。
  const activeRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeHref, tabs.length]);

  return <div className="page-tabs" role="tablist" aria-label="已打开的页面">
    <div className="page-tabs-list">
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
            <Menu.Item key="refresh" disabled={!isActive}><IconRefresh /> 刷新当前</Menu.Item>
            <Menu.Item key="close" disabled={tab.href === HOME_TAB.href}><IconClose /> 关闭当前</Menu.Item>
            <Menu.Item key="others">关闭其它</Menu.Item>
            <Menu.Item key="all">关闭全部</Menu.Item>
          </Menu>}
        >
          <button
            ref={isActive ? activeRef : undefined}
            type="button"
            role="tab"
            aria-selected={isActive}
            tabIndex={isActive ? 0 : -1}
            className={isActive ? "page-tab active" : "page-tab"}
            onClick={() => gotoTab(tab.href)}
            onAuxClick={(event) => { if (event.button === 1 && tab.href !== HOME_TAB.href) close(tab.href); }}
          >
            <span className="page-tab-text">{tab.title}</span>
            {tab.href !== HOME_TAB.href && <span
              className="page-tab-close"
              role="button"
              tabIndex={-1}
              aria-label={`关闭 ${tab.title}`}
              onClick={(event) => { event.stopPropagation(); close(tab.href); }}
            ><IconClose /></span>}
          </button>
        </Dropdown>;
      })}
    </div>
    <div className="page-tabs-actions">
      <button type="button" className="page-tabs-action" onClick={refresh} aria-label="刷新当前页" title="刷新当前页"><IconRefresh /></button>
      <button type="button" className="page-tabs-action" onClick={closeThemAll} aria-label="关闭全部页签" title="关闭全部页签"><IconClose /></button>
    </div>
  </div>;
}
