# TunexPay 前端审查报告

> 对象：`apps/web`（Next.js 16.3.5 + React 19.3.0 + Arco Design 2.66，约 10,800 行 TS/TSX/CSS）
> 验证：`tsc --noEmit` 通过、`vitest run` 21 文件 156 用例全通过、`next build` 21 路由全部产出

---

## 总体评价

代码质量明显高于同类项目。注释解释的是**为什么**而不是**做了什么**，多处注释记录真实踩过的坑
（StrictMode 双挂载竞态、`[arco-theme]` 属性在 body 上导致 html 级变量被覆盖、Arco CSS 晚于
admin.css 加载导致覆盖失效、响应式规则必须写在基础规则之后）。多个非平凡算法被抽成纯函数并配有
单测（`tabs.ts` 的关闭规则、`theme.ts` 的对比度逼近、`admin-refund.ts` 的金额解析、`paging.ts`）。

下面按「必须改 / 建议改 / 可选」三档给出 6 个必须项、8 个建议项、5 个可选项。

---

## 一、必须修复（P0/P1）

### P0-1 系统监控页的颜色对比度不达标（WCAG AA 失败）

`components/system.tsx:35`

```ts
const VALUE_COLOR: Record<Tone, string> = {
  ok: "var(--success)",      // #00B42A
  warn: "var(--warning)",    // #EC7E00
  danger: "var(--danger)",   // #E23B4A
};
```

这三色直接用作 `Statistic` 的数值文字色，但它们是**填充/边框语义色**，不是文字色。实测对比度：

| 前景 | 背景（panel #FFF） | 对比度 | AA 4.5:1 |
| --- | --- | --- | --- |
| `--success` #00B42A | 白 | **2.78** | ❌ |
| `--warning` #EC7E00 | 白 | **2.78** | ❌ |
| `--danger` #E23B4A | 白 | **4.24** | ❌ |

而项目自己已经定义了文字专用变体，全站其他位置都在用：`--success-text` 5.50、`--warning-text`
5.02、`--danger-text` 6.47 —— 全部达标。`globals.css:46-49` 的注释甚至专门解释了为什么要有
`--*-text` 这一层：

> `/* 语义文字色：与底色分离，确保 WCAG AA 对比度（4.5:1）*/`

`dashboard.tsx` 的警示卡片同样走 `.stat-red` / `.stat-orange`（只用于 `border-top-color`，
不涉及文字，没问题）。所以这是全站唯一一处遗漏。

**修复**：`VALUE_COLOR` 换成 `var(--success-text) / var(--warning-text) / var(--danger-text)`。
暗色模式下 `--success-text` 等同样存在（`#42D160` 等），一处改动双模式均达标。

### P0-2 `useApi` 初次加载无条件清空已显示数据，造成长列表闪烁

`lib/api.ts:71-78`

```ts
useEffect(() => {
  setLoading(true);
  setData(null);      // ← 问题
  setMeta(null);      // ← 问题
  setError("");
  setUpdatedAt(null); // ← 问题
  void run();
}, [run, intervalMs]);
```

`run` 依赖 `path`，`path` 依赖分页/筛选/排序（`orders.tsx:55-57`、`refunds.tsx:55-57`）。
于是**任何筛选器变化都会先把 `data` 置 null**：用户点「查询」→ 整表瞬间变成骨架屏 →
新数据回来再重建表格。分页同理（`pager.clamp` 引发的 path 变化）。

组件作者明显意识到了这一点，并用 `pathPending` 做了补偿（`api.ts:110-116`），
`safeLocalRedirectPath` 那类纯逻辑也都测过了 —— 但这个补偿只覆盖了 `resolvedPath`，
`setData(null)` 仍然真实发生，只是渲染时被 `pathPending` 挡住。结果是：
`LoadingState` 收到 `loading=true`（渲染骨架），**数据已不在 state 里**。

具体后果：
1. 切分页/筛选时，`stale={Boolean(data)}` 中的 `data` 恒为 `null`，错误降级文案
   (`common.tsx:349-355`) 永远走不到「以下为上次成功读取的数据」分支 —— 这条本为
   8 秒轮询页设计的降级路径，在手翻页时反而失效；
2. 抽屉类组件（`orders.tsx:161` 的 `OrderDetailBody`）在 path 变化瞬间丢失上下文；
3. 无谓的双倍渲染。

**修复方向**：把「切换 path」与「首次加载」区分开 —— 仅当 `resolvedPath === null`（从来没成功过）
时才清空 data；path 变化时保留旧 data 并让 `pathPending` 充当 loading 闸门（它已经是这么设计的）。
约 5 行改动。

### P1-1 `useApi` 轮询间隔在隐藏标签页里仍触发 `setInterval` 回调

`lib/api.ts:87-93` 的护栏写在回调内部（`isForegroundOnline()` 判断），这是对的；
但 `setInterval` 本身以 `intervalMs` 全速运行。系统监控页 `useApi(..., 5_000)`、
订单页 `8_000`、通知投递 `10_000` —— 单页 5 秒一跳不是问题，但 `page-tabs.tsx` 之后
**多个页面的 hook 实际处于挂载状态**（Next App Router 会保留已访问路由的客户端状态
直到路由缓存回收），叠加起来后台会有若干定时器持续唤醒主线程。

低风险、建议顺手处理：给定时器加一层 `document.visibilityState` 的显式 pause/resume
（`onResume` 已经写了，只差把 timer 也管起来），或直接降低轮询频率。

### P1-2 复制失败的兜底路径在 `finally` 前 return，导致 `node.removeChild` 被跳过

`components/common.tsx:45-65` 的 `writeClipboard`：

```ts
try {
  const node = document.createElement("textarea");
  ...
  const ok = document.execCommand("copy");
  document.body.removeChild(node);   // 若 execCommand 抛错，这行不执行
  return ok;
} catch {
  return false;
}
```

`execCommand` 在部分浏览器下会抛异常（尤其非用户手势触发的合成事件里）。异常路径下那个
`position: fixed; opacity: 0` 的 textarea 会遗留在 `<body>` 中。它视觉不可见、不阻塞交互，
但会成为 DOM 里的幽灵节点，且 `document.execCommand` 已被废弃、未来版本直接移除时此路径必然抛错。

**修复**：`try/finally` 包住 removeChild，或改用 `document.body.removeChild(node)` 于 `finally`。

### P1-3 `safeLocalRedirectPath` 允许 `\` 之外的协议相对/反斜杠变形之外的形式

`lib/navigation.ts:2` 已经挡住了 `//` 与 `\`，并用 `URL` 比对 origin —— 写得很好，
`navigation.test.ts` 6 个用例也覆盖了。但有一类遗漏：`/\evil.com`。它 `startsWith("/")`、
不含 `\`、`new URL("/\\evil.com", base).origin === base.origin`（解析成 `https://tunexpay.local/evil.com`），
最终返回 `pathname + search + hash` = `/evil.com`。这是**本地路径**，不会跳出站，不构成漏洞，
但若后端对 `/evil.com` 做开放式跳转就会有二次风险。当前用法（登录后 `window.location.assign`）安全。

结论：仅记录，不必改。若要加固，可加一条 `if (value.startsWith("/") && value[1] === "/") fallback`
（其实已被现有 `//` 检查覆盖）—— 无需改动。

### P1-4 管理台消息通道全部只有 `aria-live="polite"`，无 `role="status"` 容器预置

`components/common.tsx:105` 的 Toast 用了 `role={type === "error" ? "alert" : "status}`
aria-live="polite"` —— 正确。但 **`operation-notice` 系列（全站通知主通道）没有 live region**：

- `order-detail.tsx:70,71` 异常提示
- `refunds.tsx` / `channels.tsx` / `exceptions.tsx` 的 `operation-notice ok/error`
- `bill-settings.tsx:77` 的保存反馈

这些是**操作结果反馈**（"通道配置已保存"、"退款已发起"），屏幕阅读器用户点击保存后
得不到任何播报。`exceptions.tsx` 的 `Toast` 有 role，但 `order-detail.tsx:70` 等的静态
`operation-notice` 没有。

**修复**：给 `.operation-notice` 容器统一加 `role="status"`（错误场景 `role="alert"`），
或让 `Toast` 成为操作反馈的唯一出口。改动小、收益明确。

---

## 二、建议改进（P2）

### P2-1 `apps/web` 无 ESLint 配置 — ✅ 已引入（2026-10-11）

仓库根无 `.eslintrc*` / `eslint.config.*`，`apps/web` 也没有，package.json 无 lint 脚本。
考虑到这个项目的自定义规范很多（图标必须 `aria-hidden`、`data-sort-value` 标注规则、
`admin.css` 冻结约定、Arco 覆盖的加权写法），这些规范**目前只靠 `interaction-details.test.tsx`
的源码扫描断言守护**。源码扫描是有效的，但覆盖面天然有限。

建议：至少引入 `eslint-plugin-jsx-a11y` 的可自动修复子集（`alt-text`、`aria-props`、
`label-has-associated-control`），把已在测试里固定的规则部分下沉到 lint。

**实施记录**：装的是 `eslint@9.39.1` + `typescript-eslint@8.71.1` +
`eslint-plugin-jsx-a11y@6.10.2`，配置在 `apps/web/eslint.config.mjs`，`lint` 脚本 +
CI test 阶段前一步。选 9.x 而不是仓库里原本躺着的 eslint 10 的原因：
`typescript-eslint@8.46` 的 peer 要求 eslint ^8||^9，10 会被拒。

**刻意没装 react-hooks / exhaustive-deps**：本项目用了不少刻意规避 effect 重跑的写法
（`lib/api.ts` 的 `resolvedPathRef` 就是典型 —— 依赖里放 ref 会每次成功都重跑一次请求），
插件会与这些设计长期打架，误报率高于收益。同理 `no-unused-vars` 只保留 `_` 前缀豁免，
其余的交给 `tsc --noEmit`。

**跑通之后处理了 43 条存量告警，分三类**：
- 21 条 `label-has-associated-control` 是假阳性 —— 规则只认原生小写 `<input>/<select>`，
  而本项目全部用 Arco 的 `<Input>`/`<Select>`/`<Switch>`。用规则的 `controlComponents`
  告知这些组件名后剩 27 条，剩下的是 `FilterItem`/`NumberField` 这类自定义包装
  （label 是组件返回的，插件跨不了组件边界），给了范围豁免并注明由别的测试守着。
- 12 条 `no-autofocus` 也是假阳性 —— 全落在 Arco `<Modal>` 上，配合 `focusLock`
  把焦点移进对话框正是对话框该做的事，与「页面加载抢焦点」是两回事。整条关闭。
- 4 条是真问题，已修：`orders.tsx` 未使用的 `Tag` 导入、`nav-progress.ts` 的
  `listeners` 该用 `const`、`list.tsx` 的 `useTableSort<T>` 泛型未使用（改 `_T`）、
  `lib/api.ts` 的 `any` 收窄成 `unknown` 再窄化读 `error.message`。

**诚实的边界**：`label-has-associated-control` 只检查「label 里有没有嵌套控件」，
**不检查「控件有没有 label」**。所以 `<label>关键字</label><Input/>` 这种真正最坑的
分离写法它抓不到 —— 实测确认过。本次修掉的 `FilterItem` 那类问题最终靠的是人工审查
加 Playwright 实测，ESLint 拦的是 ARIA 属性拼错、div 挂 onClick 这类低级错误。
新增 `apps/web/lib/eslint-wiring.test.ts`（6 条）守着「接线没被拔掉」，并把这条边界
写在了测试注释里，避免后人高估它。

### P2-2 `themeBootstrapScript` 的 `fn.toString()` 序列化是隐式契约

`lib/theme.ts:284-288` 把 12 个函数的源码拼进内联脚本。这是个聪明的做法（保证首屏与运行时
公式一致），但契约完全靠注释维系：

```ts
// 注意：这里必须把 deriveVars 依赖的【所有】函数都序列化进去。
// 漏一个（如 contrast / ensureContrast）会让 deriveVars 在浏览器里抛错，
// 而外层 try/catch 会把它静默吞掉
```

风险：将来给 `deriveVars` 加一个 helper（比如新的颜色空间转换），忘记加进数组，
表现为「自定义配色保存了但不生效」且无控制台报错。已有 10 个 theme 单测，但测的是函数本身
而非脚本完整性。

建议：加一条测试，在 Node 里执行生成的脚本（`theme.test.ts:108` 已经有这个模式了 ——
用 `new Function` 跑了脚本！），断言把 colors 写进 body 后读回的值与 `themeVars()` 直算一致。
这样漏函数会立刻红灯，而不是线上静默失效。

### P2-3 `shell.tsx` 的主题 effect 依赖 `prefsTouched` 但读的是 effect 外的 `dark`

`components/shell.tsx:127-133`：

```ts
useEffect(() => {
  document.body.setAttribute("arco-theme", dark ? "dark" : "light");
  applyColors(getColors(), dark);
  if (!prefsTouched) return;
  try { window.localStorage.setItem(THEME_KEY, dark ? "dark" : "light"); } catch {}
}, [dark, prefsTouched]);
```

`applyColors(getColors(), dark)` 每次 `dark` 或 `prefsTouched` 变化都重算整套 CSS 变量
（内联 style 覆写 ~20 个属性）。`prefsTouched` 是无关变量，它变化时会触发一次无意义的重算。
功能正确，纯属多余渲染开销。放入依赖数组可能是为了「首次从 localStorage 读出 dark 后立即重算」，
但 `dark` 变化本身就会触发。可把 `prefsTouched` 从第一个 effect 的依赖中拿掉
（它只影响第二个 effect 的写回分支）。

### P2-4 `common.tsx:364` 的 `time()` 依赖运行时本地时区

```ts
export function time(value) {
  ...
  return date.toLocaleString("zh-CN", { hour12: false });
}
```

支付系统的时间展示若服务端与管理员不在同一时区，会出现歧义。`toLocalDateTimeInput()`
（`common.tsx:367`）已经在处理 `getTimezoneOffset()`，说明作者意识到时区问题，
但只处理了输入方向。建议在时间旁显示时区缩写，或在页脚固定声明「时间按浏览器本地时区展示」
（`shell.tsx:236` 的 footer 是现成的挂点）。对跨国部署的收银台尤其重要 ——
`cashier.tsx` 的倒计时用 `Date.parse` 是绝对时间，没问题，但展示的「创建时间」会偏。

### P2-5 `channels.tsx` 的 `window.open` + `location.replace` 组合在部分场景下被拦截

`components/channels.tsx:106-121` 的做法已经相当严谨（同步预留窗口、`opener = null`、
失败降级为可见链接 + 提示文案）。残留风险：`window.open` 在**非用户手势的异步链**中
（例如 `await api(...)` 之后才调用）会被拦截 —— 但这里是在 onClick 同步阶段打开的，正确。

唯一可改进点：`cashierWindow.opener = null` 之后 Safari 仍可能通过 `window.name` 之类
泄漏引用；`noopener` 已足够。**无需改动**，仅记录为已正确处理。

### P2-6 大量表格列重复定义，缺少抽取

`orders.tsx`(165 行) / `refunds.tsx`(266) / `exceptions.tsx`(251) / `owner-notifications.tsx`(681)
/ `channels.tsx`(307) 各自定义一份 `SORT_COLUMNS` + `useServerPager/useClientPager` + `sortHeader`
+ `sortValueProps` 组合。这个模式高度一致（这是好事 —— 说明统一模型落地了），
但也意味着「排序列的 accessor 与列头 label」这类对应关系存在 5 份。

`list.tsx` 已提供了 `sortHeader` / `useTableSort`，可以考虑再收一层：
`useSortableTable(columns, data, { pager: "server" | "client" })` 一次性返回
`{ columns, rows, pager, sort, onSort }`。收益是每个列表页少 10~15 行样板，
且 `sortAndResetPage` 这个「排序时重置页码」的规则只存在于一处（现在是每页手写一遍，
漏写就会出现「排序后停在第 7 页但第 7 页在新排序下不存在」的边界 bug）。

### P2-7 `error.tsx` / `global-error.tsx` 三层边界齐全，但都没有上报

`app/error.tsx`、`app/global-error.tsx`、`(admin)/error.tsx`、`(public)/error.tsx`
四处都只展示 digest。digest 是本地的，服务端日志里若不关联用户操作上下文，
拿到 digest 也查不到东西。属于产品决策，非代码缺陷。

### P2-8 测试覆盖偏向纯函数，组件测试偏少

156 个用例中，纯逻辑（theme / sort / tabs / api / retry / session / version）约 120 个；
组件测试集中在 `error-state` / `version-badge` / `routing-target` / `interaction-details`（源码扫描）
/ `hover-detail` / `loading-state` / `table-layout`。**资金路径**（`refunds.tsx` 的提交、
`order-detail.tsx` 的关闭弹窗、`bill-settings.tsx` 的密钥清除确认）没有组件级测试，
而这些正是对话框里最容易写错状态机的地方（`busy` 与 `dirty` 的交互、成功后关窗与刷新的顺序）。

`lib/admin-refund.ts` 做了纯函数级测试是好实践，但 `submitRefund` 的
「失败保留幂等键 / 成功换页」逻辑（`refunds.tsx:94-112`）没有守护。

---

## 三、可选优化（P3）

1. **`command-palette.tsx` 的 `setTimeout(..., 60)` 聚焦**：60ms 是猜的，某些慢设备上
   Modal 还在挂载动画中，焦点可能落在 body。可用 Arco Modal 的 `onOpen` 回调替代。
2. **`shell.tsx` 的 `useMediaQuery` 未加 SSR 兜底**：初始 `false`， hydration 后修正。
   已在注释说明，且 `app-shell` 的 class 是布局级的，无闪烁风险。无需改。
3. **`VersionBadge` 每次挂载打一次 `/api/version`**：页签切换不会重挂载（Shell 常驻），
   影响很小。可考虑只在路由变化时校验。
4. **`apps/web` 的 `qrcode` 依赖（1.5.4）只在收银台用到**：已通过 dynamic import 隔离，
   `cashier.tsx` 是 `ƒ` 动态路由，不进管理台首屏包。做好了的。
5. **`admin.css` 1169 行 + `globals.css` 387 行**：注释里多次提到「admin.css 已冻结」，
   说明团队有意控制其增长。建议在 CODEOWNERS 或 PR 模板里写明这一点，
   否则新贡献者很容易往里加规则而破坏「响应式在基础规则之后」的约定。

---

## 四、值得保留的做法（正面）

审查中发现这些实践应当明确保留并作为团队约定：

- **纯函数抽取**：`tabs.ts` / `theme.ts` / `admin-refund.ts` / `retry.ts` / `sort.ts` 的
  「非平凡逻辑 + 单测」模式，是资金类前端最可靠的护栏。
- **`useApi` 的轮询护栏**：skip-in-flight、隐藏页暂停、切回前台节流（`api.ts:79-97`），
  这是很多项目会漏的。
- **`HoverDetail` 的 fixed 定位 + 滚动收起**（`common.tsx:297-344`）：注释解释了为什么
  不能用 absolute（overflow 容器裁剪），是正确的推理。
- **`CopyValue` 的 execCommand 兜底 + 不谎报成功**（`common.tsx:81-91`）：只在确认写入后
  才显示「已复制」，且提示语区分了 HTTP 场景。细节到位。
- **`session.ts` 的 HMAC + 过期 + issuedAt 未来时钟容差**：`lib/session.ts:26` 的
  `issuedAt <= current + 60` 处理时钟漂移，是生产级写法。
- **CSP 逐路由下发**（`next.config.ts:12-20`）：只给 cashier 与 public API 加
  `frame-ancestors 'none'`，管理台不加（需要内联脚本与 Arco 样式），是精准的取舍。
- **`dangerouslySetInnerHTML` 的唯一用途是主题引导脚本**（`layout.tsx:29`），
  内容由服务端函数生成、不含任何用户输入，且 `suppressHydrationWarning` 的理由写在注释里。
- **`retainAllowedTools`**（`form-safety.ts:2`）防止 scope 降级时残留越权工具选择 ——
  这是安全思维的体现。

---

## 五、优先处理顺序

> ✅ 前四项已完成并验证（typecheck / 159 测试 / next build 全绿）。
> 加上 P2-1 / P2-2 / 表单与弹窗专项后为 typecheck / lint / 195 测试 / next build 全绿。

| 序号 | 项目 | 工作量 | 影响 | 状态 |
| --- | --- | --- | --- | --- |
| 1 | P0-1 `system.tsx` 对比度 | 3 行 | 可访问性合规（AA 失败） | ✅ 完成 |
| 2 | P0-2 `useApi` 清空已显示数据 | ~5 行 | 全站列表页体验 | ✅ 完成 |
| 3 | P1-4 `operation-notice` live region | 3~5 处 | 屏幕阅读器可用性 | ✅ 完成 |
| 4 | P1-2 `execCommand` 兜底 finally | 1 行 | DOM 卫生 | ✅ 完成 |
| 5 | P2-2 主题脚本完整性测试 | 1 个测试文件 | 防线上静默失效 | ✅ 完成 |
| 6 | P2-1 ESLint a11y | 配置 + 修 4 处存量 | 长期护栏 | ✅ 完成 |

表单与弹窗专项（用户截图触发）另见第六节：P2-9 Arco Modal 高度失控（保存按钮不可达）、
P2-10 `FilterItem` 标签无关联。底部测试数为 195（含新增回归）。

前 4 项已合成一个变更集（8 个文件，+43/-14），新增
`apps/web/lib/api-stale-data.test.ts` 3 条源码不变量测试，并用「改回旧行为 → 测试失败 →
恢复」验证过测试真的能拦住回归。

### 实施说明与判断记录

**P0-2（`useApi`）**：保留 `pathPending` 渲染闸门不变（它继续把未解析 path 的 data 挡成
`null`，首屏仍是骨架屏），只把根因「无条件 `setData(null)`」改成「仅当这个 hook 从来没成功
读过数据时才清空」。为此加了 `resolvedPathRef` —— 因为 path 变化的 effect 要在渲染前知道
「之前有没有成功过」，而直接把 `resolvedPath` 读进 effect 依赖会让每次成功都重跑一次请求。
ref 在成功与失败两条路径都写入：漏掉失败那条，切到出错的 path 再切回来会被误判成首屏而清空数据。

**P1-4（live region）**：只给「操作反馈」补 role；`order-detail.tsx:70-71` 那两条**没有**加，
并补了注释说明原因 —— 它们是随数据呈现的常驻状态横幅，每次进入页面都会出现，
做成 live region 会让屏幕阅读器在轮询刷新时反复播报。这一类在审查报告里没有细分，
实施时区分开了。另外把 `cashier.tsx` / `login.tsx` 原有的 `aria-live="polite"` 统一成
`role="alert"`，与全站其他错误提示的写法一致（`Toast`、`LoadingState`、各表单错误）。

---

## 六、表单与弹窗专项（用户截图反馈后追加）

### P2-9 Arco Modal 高度失控：长表单的保存按钮被顶出视口且无处可滚

这是用户截图的直接问题。**根因不是组件写错，而是 CSS 没跟上框架迁移**：

`admin.css:221` 附近仍留着迁移前手写的 `.modal` / `.modal-mask` 规则，而所有弹窗早已换成
Arco 的 `<Modal className="app-modal">`。`.app-modal` 在 `admin.css` 里**一条规则都没有**
（`grep -c app-modal` = 0），于是弹窗完全用组件库默认外观：

- `.arco-modal` 固定 `width:520px` + `top:100px`，`alignCenter` 下改成 `inline-block` 垂直居中；
- `.arco-modal-content` 是 `overflow:visible`，不限高，滚动交给 wrapper；
- 结果：内容一长就只有两种结局 —— wrapper 整页滚动（遮罩跟着滚、按钮在视口外），
  或 `alignCenter` 下底部被顶出视口。

用 Playwright 在 1440×720 注入等长表单实测（修复前）：内容底边 2211px、保存按钮底边 2171px、
`docScrolls:false`、`internalScroll:false` —— **保存按钮在 720px 高的视口里点不到，且没有任何滚动条**。

修复（`admin.css`，含注释说明踩坑过程）：

1. `width` / `max-height` 作用在 `.arco-modal` 上 —— Arco 把 `className` 放在这一层
   （`Modal/modal.js: cs(prefixCls, ..., className)`），不是 content 层；
2. 选择器必须写成 `html .app-modal-layer .arco-modal.app-modal`（(0,4,0)）：
   组件库的 `.arco-modal-wrapper.arco-modal-wrapper-align-center .arco-modal` 是 (0,3,0)，
   会把 `.arco-modal` 改成 `display:inline-block` + `top:0`，等特异性只看先后而两张样式表的
   注入顺序不可依赖。这是本项目「Arco 反超」问题的又一个实例（`frontend-redesign.md` 已记过一次）；
3. `focusLock` 会在 `.arco-modal` 与内容之间插入一个**无类名的 div**，链条上任一环还是
   `min-height:auto`（flex 子项默认值）都会把限高整个顶穿。所以对 `> *` 也补了
   `min-height:0` + `display:flex;flex-direction:column`；
4. 末尾操作栏（`.bill-settings-actions` / `.dialog-actions`）做成 `position:sticky; bottom:-20px`
   贴在滚动容器底部 —— 表单一长，保存按钮就不该被滚出视口；
5. 删掉失效的 `.modal` / `.modal-mask` / `.modal .drawer-body` 死规则。

配套改动：`common.tsx` 的 `Modal` 加 `wrapClassName="app-modal-layer"`；
`applications.tsx` / `owner-notifications.tsx` 里 4 处直接使用 Arco `Modal` 的弹窗补上
`className="app-modal"` + `wrapClassName`（这 4 处之前连 `className` 都没有，
一直用的是组件库 520px 默认宽度）。

Playwright 复验（真实点击「创建通道」，选中字段最多的支付宝账单收款插件，22 个控件）：

| 视口 | 弹窗尺寸 | 限高生效 | 内容可滚 | 保存按钮 |
|---|---|---|---|---|
| 1440×900 | 640×852 | ✓ | ✓（804/1743） | ✓ |
| 1440×720 | 640×672 | ✓ | ✓（624/1743） | ✓ 常驻可点 |
| 1366×640 | 640×592 | ✓ | ✓（544/1743） | ✓ |
| 390×844 | 390×820 | ✓ | ✓（772/2381） | ✓ |

### P2-10 `FilterItem` 的标签与控件没有关联（54 处）

`components/list.tsx` 的 `FilterItem` 用 `<div>` + 两个 `<span>` 渲染「标签 + 控件」。
后果：屏幕阅读器只会念到一串**没有可访问名**的输入框（各页面筛选器全部中招，
本组件被 12 个页面复用，共 54 处调用）；点标签文字也不能把焦点带进输入框。

改为 `<label>` 包裹文案与控件（隐式关联，单控件场景与 `htmlFor` 等价 ——
控件由调用方传入，id 由 Arco 内部生成，拿不到也不该去猜）。`admin.css:651` 的
`.filter-item { display:flex }` 保证横向布局不变，浏览器实测验证过。

### 其余表单审查结论（无需改动的部分）

- **标签关联**：`bill-settings.tsx` / `mcp-access.tsx` / `login.tsx` 全部用原生 `<label>`
  包裹控件，已具备隐式关联；`channel-editor.tsx` / `owner-notifications.tsx` /
  `routing-groups.tsx` 用 Arco `Form.Item` 的 `label`。都没有问题。
- **防重复提交**：所有提交按钮都同时给了 `loading` + `disabled`（含取消按钮），
  `bill-settings.tsx` / `mcp-access.tsx` / `channel-editor.tsx` 还在无修改时禁用提交
  并显示「尚无修改」而不是留一个能点却没反应的按钮。
- **原生校验**：`bill-settings.tsx:128` 的 `NumberField` 保留 `type=number` + `required` +
  `min`/`max`，让浏览器在提交前拦空值和越界值，没有另写一套校验提示 —— 判断合理，保留。
- **Drawer**：订单详情的 Drawer 走的是另一套结构（`.arco-drawer` + `.drawer-body`），
  实测高度撑满、内部滚动正常，不受本次弹窗问题影响。

### 新增回归测试

`apps/web/components/modal-form-layout.test.tsx`，13 条。项目没有 jsdom，
所以 DOM 用 `renderToStaticMarkup`、其余用源码不变量（沿 `interaction-details.test.tsx` 的做法；
Arco `Modal` 在静态渲染下输出空串，故 props 改为读源码断言）。覆盖：挂钩是否还在、
限高/滚动/min-height 链、选择器加权（(0,4,0)）、sticky 操作栏、死规则清理、`FilterItem` 结构。
已用「改回旧行为 → 测试失败 → 恢复」逐条变异验证（6 组变异全部被捕获）。
