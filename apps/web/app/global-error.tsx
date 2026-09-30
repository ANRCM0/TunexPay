"use client";

// 根布局自身出错时，Next 会用它替换整个根布局，globals.css 不会生效，所以这里只能内联样式。
// 这一层极少触发，用途是让白屏变成一个能看懂、能自救的页面。
const shell: React.CSSProperties = {
  minHeight: "100vh",
  display: "grid",
  placeItems: "center",
  padding: "32px 18px",
  margin: 0,
  background: "#f5f7fb",
  color: "#243143",
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
};

const card: React.CSSProperties = {
  maxWidth: "460px",
  textAlign: "center",
  background: "#fff",
  border: "1px solid #e4e9f2",
  borderRadius: "12px",
  padding: "34px 26px",
  boxShadow: "0 1px 3px rgba(36, 49, 67, .06)",
};

const mark: React.CSSProperties = {
  width: "38px",
  height: "38px",
  margin: "0 auto 12px",
  display: "grid",
  placeItems: "center",
  borderRadius: "50%",
  background: "#fdeceb",
  color: "#e5534b",
  fontWeight: 900,
  fontSize: "19px",
};

const button: React.CSSProperties = {
  marginTop: "6px",
  border: 0,
  borderRadius: "8px",
  background: "#2563eb",
  color: "#fff",
  padding: "10px 16px",
  fontWeight: 600,
  fontSize: "13px",
  cursor: "pointer",
};

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <html lang="zh-CN">
    <body style={shell}>
      <div style={card} role="alert">
        <div style={mark} aria-hidden="true">!</div>
        <h2 style={{ margin: "0 0 8px", fontSize: "18px" }}>管理台无法启动</h2>
        <p style={{ margin: 0, color: "#7a869a", fontSize: "13px", lineHeight: 1.65 }}>
          应用在加载基础布局时失败了。可以先重新加载；如果仍然打不开，说明前端构建或配置有问题，请联系管理员。
        </p>
        {error.digest && <p style={{ margin: "10px 0 0", color: "#7a869a", fontSize: "12px" }}>错误编号 {error.digest}</p>}
        <button style={button} type="button" onClick={reset}>重新加载</button>
      </div>
    </body>
  </html>;
}
