"use client";

import { Empty, Input, Modal } from "@arco-design/web-react";
import type { RefInputType } from "@arco-design/web-react/es/Input";
import { IconSearch } from "@arco-design/web-react/icon";
import { useEffect, useMemo, useRef, useState } from "react";
import { HOME, NAV_GROUPS, type NavItem } from "../lib/nav";
import { useNavPush } from "../lib/nav-progress";

type Entry = NavItem & { group: string };

const ENTRIES: Entry[] = [
  { ...HOME, group: "总览" },
  ...NAV_GROUPS.flatMap(group => group.items.map(item => ({ ...item, group: group.title }))),
];

/**
 * 命令面板：Ctrl/Cmd + K 之后输入关键字直达任意页面。
 *
 * 管理台有 15 个菜单项且分组收在二级里，找页面要么逐个展开、要么记路径；
 * 这里给一条纯键盘通道。只做跳转，不改任何业务状态。
 */
export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const push = useNavPush();
  const [keyword, setKeyword] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<RefInputType>(null);

  const results = useMemo(() => {
    const needle = keyword.trim().toLowerCase();
    if (!needle) return ENTRIES;
    return ENTRIES.filter(entry =>
      `${entry.group}${entry.title}${entry.href}`.toLowerCase().includes(needle),
    );
  }, [keyword]);

  useEffect(() => {
    if (open) {
      setKeyword("");
      setCursor(0);
      window.setTimeout(() => inputRef.current?.dom?.focus(), 60);
    }
  }, [open]);

  // 上下键移动、回车进入。列表不超过一屏，不做虚拟滚动。
  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === "ArrowDown") { event.preventDefault(); setCursor(value => Math.min(value + 1, results.length - 1)); }
    else if (event.key === "ArrowUp") { event.preventDefault(); setCursor(value => Math.max(value - 1, 0)); }
    else if (event.key === "Enter") {
      event.preventDefault();
      const target = results[cursor];
      if (target) { onClose(); push(target.href); }
    }
  }

  return <Modal
    className="command-palette"
    title={null}
    footer={null}
    visible={open}
    onCancel={onClose}
    autoFocus={false}
    focusLock
    alignCenter
    maskClosable
  >
    <Input
      ref={inputRef}
      size="large"
      allowClear
      prefix={<IconSearch aria-hidden="true" />}
      placeholder="输入页面名称或路径，回车跳转"
      value={keyword}
      onChange={setKeyword}
      onKeyDown={onKeyDown}
      aria-label="搜索页面"
    />
    <ul className="command-list" role="listbox" aria-label="页面列表">
      {results.map((entry, index) => {
        const Icon = entry.icon;
        return <li key={entry.href}>
          <button
            type="button"
            role="option"
            aria-selected={index === cursor}
            className={index === cursor ? "command-item active" : "command-item"}
            onMouseEnter={() => setCursor(index)}
            onClick={() => { onClose(); push(entry.href); }}
          >
            <Icon size={16} aria-hidden="true" />
            <span className="command-title">{entry.title}</span>
            <span className="command-group">{entry.group}</span>
          </button>
        </li>;
      })}
      {!results.length && <li><Empty description="没有匹配的页面" /></li>}
    </ul>
  </Modal>;
}
