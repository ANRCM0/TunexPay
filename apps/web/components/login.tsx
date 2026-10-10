"use client";

import { Button, Input } from "@arco-design/web-react";
import { IconLock } from "@arco-design/web-react/icon";
import { FormEvent, useState } from "react";
import { safeLocalRedirectPath } from "../lib/navigation";

/**
 * 管理员登录。
 *
 * 版式对齐 MPAY 管理台登录页：一张居中卡片，左侧品牌说明、右侧表单，
 * 输入框用 Arco 的灰底无边框样式，主按钮整行宽。
 */
export function Login() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError("");
    const form = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: form.get("password") }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error?.message ?? "登录失败");
      const requested = new URLSearchParams(window.location.search).get("next");
      window.location.assign(safeLocalRedirectPath(requested));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "登录失败");
      setLoading(false);
    }
  }

  return <main className="login-shell">
    <div className="login-card">
      <section className="login-aside" aria-hidden="true">
        <div className="login-aside-brand">
          <span className="brand-mark">T</span>
          <span className="login-aside-name">TUOXIN PAY</span>
        </div>
        <h2>支付中台控制台</h2>
        <p>面向自有业务的轻量支付基础设施：订单与支付分离、退款人工推进、通知至少一次投递。</p>
        <ul className="login-aside-list">
          <li>支付状态机与异常恢复</li>
          <li>可靠通知与对账</li>
          <li>操作审计与受控资金审批</li>
        </ul>
      </section>

      <section className="login-form-panel">
        <div className="login-form-head">
          <span className="brand-mark" aria-hidden="true">T</span>
          <h1>管理后台</h1>
        </div>
        <p className="page-copy">使用部署时配置的管理员口令进入支付控制台。</p>
        <form className="login-form" onSubmit={submit}>
          <label className="sr-only" htmlFor="admin-password">管理员口令</label>
          <Input.Password
            id="admin-password"
            name="password"
            size="large"
            autoComplete="current-password"
            required
            autoFocus
            placeholder="请输入管理员口令"
            prefix={<IconLock aria-hidden="true" />}
          />
          {error && <div className="operation-notice error" aria-live="polite">{error}</div>}
          <Button type="primary" htmlType="submit" size="large" long loading={loading}>{loading ? "正在验证…" : "登录管理后台"}</Button>
        </form>
        <p className="login-note">会话保存在 HttpOnly Cookie 中，浏览器不会保存后台 API Token。</p>
      </section>
    </div>
  </main>;
}
