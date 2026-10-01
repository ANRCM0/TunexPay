"use client";

import { PageHead } from "./common";
import { OwnerNotificationsPanel } from "./owner-notifications";

export function Notifications() {
  return <>
    <PageHead eyebrow="Notifications" title="通知插件" copy="把收款、异常和采集事件订阅到邮箱、Telegram、飞书或自定义 Webhook；业务入账 Webhook 仍保持独立。" />
    <OwnerNotificationsPanel />
  </>;
}
