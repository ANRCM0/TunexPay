"use client";

import { PageHead } from "./common";
import { OwnerNotificationsPanel } from "./owner-notifications";

export function Notifications() {
  return <>
    <PageHead eyebrow="Notifications" title="本人通知" copy="收款成功、异常与采集故障通过邮箱或飞书提醒管理员；与业务 Webhook 完全独立。" />
    <OwnerNotificationsPanel />
  </>;
}
