"use client";

import { FormEvent, useState } from "react";

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
      const requested = new URLSearchParams(window.location.search).get("next") ?? "/";
      window.location.assign(requested.startsWith("/") && !requested.startsWith("//") ? requested : "/");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "登录失败");
      setLoading(false);
    }
  }

  return <main className="login-shell">
    <section className="card login-card">
      <div className="cashier-logo">T</div>
      <div className="eyebrow">TUOXIN PAY CONSOLE</div>
      <h1>管理员登录</h1>
      <p className="page-copy">使用部署时配置的管理员口令进入支付控制台。</p>
      <form className="login-form" onSubmit={submit}>
        <label>管理员口令<input name="password" type="password" autoComplete="current-password" required autoFocus placeholder="请输入管理员口令" /></label>
        {error && <div className="operation-notice error" aria-live="polite">{error}</div>}
        <button className="button" disabled={loading}>{loading ? "正在验证…" : "登录控制台"}</button>
      </form>
      <p className="login-note">会话保存在 HttpOnly Cookie 中，浏览器不会保存后台 API Token。</p>
    </section>
  </main>;
}
