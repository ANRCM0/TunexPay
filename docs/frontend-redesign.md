# 管理台前端重构（对齐 MPAY V2 / SnowAdmin + Arco Design）

## 目标

把 `apps/web` 的管理台从「手写 CSS 设计系统」迁移到与 mpay_v2_webman 一致的
**SnowAdmin 布局骨架 + Arco Design 组件体系**，同时加强性能与交互。

参照物为 MPAY V2 官方演示站（`https://test.qcjy.cc/admin`）实测计算样式，
不是从截图目测。

## 实测规格（来自线上管理台 computed style）

| 元素 | 规格 |
| --- | --- |
| 侧边栏宽度 | 220px（折叠 48px） |
| 侧边栏品牌区 | 60px 高，右侧 1px `#E5E6EB` 分隔 |
| 顶栏 | 60px 高，padding `0 16px`，下边框 1px `#E5E6EB` |
| 页签栏 | 40px 高，下边框 1px `#E5E6EB`，选中项 14px/500 `#165DFF`，padding `8px 0` |
| 内容区 | 背景 `#F7F8FA`，padding 16px |
| 菜单项 | 40px 高、`margin-bottom 4px`、`padding-left 12px`、圆角 2px、14px |
| 菜单选中态 | 背景 `#F2F3F5`，文字 `#165DFF`，字重 500 |
| 筛选控件 | 32px 高、背景 `#F2F3F5`、透明边框、圆角 2px、14px |
| 表单行 | 32px 高、`margin-bottom 8px`、标签 `#4E5969` 14px |
| 表头 | 背景 `#F2F3F5`、`#1D2129`、14px/500 |
| 表格单元格 | 下边框 1px `#E5E6EB`、`#1D2129`、14px，多行内容行高约 93px |
| 卡片 | 背景 `#fff`、圆角 8px |
| 结构 | 查询表单 + 表格 + 分页同处一张白卡；分页右对齐，分页上方有分隔线 |

## 色板（Arco，rgb 三元组形式）

```
主色     arcoblue-6  rgb(22, 93, 255)   #165DFF
hover    arcoblue-5  rgb(64, 128, 255)  #4080FF
active   arcoblue-7  rgb(14, 66, 210)   #0E42D2
浅底     arcoblue-1  rgb(232, 243, 255) #E8F3FF
文字 1   #1D2129    文字 2 #4E5969     文字 3 #86909C
填充 1   #F7F8FA    填充 2 #F2F3F5     边框 #E5E6EB     描边深 #C9CDD4
成功     #00B42A    警告 #FF7D00       危险 #F53F3F
圆角     small 2px  medium 4px  large 8px
字体     Inter, -apple-system, BlinkMacSystemFont, "PingFang SC", ...
```

## 落地约定

- 组件库统一用 `@arco-design/web-react`，不再手写 Button/Card/Table/Modal/Drawer/Select。
- 保留项目原有的无障碍契约（`role="tab"` roving tabindex、`hover-detail`、`copy-value`、
  `version-dot` 等类名与行为），这些有测试守着。
- `shell.tsx` 必须保留 `<Icon size={17} aria-hidden="true" />` 字面量：
  `components/interaction-details.test.tsx` 会扫描源码断言所有图标都带 `aria-hidden`。
- **Tailwind 已移除**。它在本项目里没有任何工具类在用，而它的 preflight 会把 `svg`
  设成 `display: block`，直接破坏 Arco 所有组件里的图标排版。基础重置由 `globals.css`
  自己负责（`box-sizing`、`body margin`、`button/input` 字体继承、`table` 合并边框等）。

## 结构

```
app/globals.css          设计令牌 + 跨界面原语（登录/收银台也用）
app/(admin)/admin.css    管理台骨架 + 页面级样式
components/arco-provider ConfigProvider(zh-CN) + React 19 适配器 + Arco CSS
components/shell.tsx     Sidebar(220/48) + Header(60) + PageTabs(40) + Content
components/page-tabs.tsx 多页签栏（可关闭/刷新/右键菜单，localStorage 持久化）
components/list.tsx      列表页原语：ListPage/FilterCard/ListCard/Pager/useClientPager/useTableSort/sortHeader
components/common.tsx    共享原语：PageHead/Section/Stat/Status/CopyValue/HoverDetail/Drawer/Modal/Tabs
components/command-palette.tsx  Ctrl/Cmd+K 快速跳转
components/route-progress.tsx   基于 useTransition 的真实导航进度条
lib/nav.ts               导航配置（侧栏、面包屑、页签标题的唯一来源）
lib/tabs.ts              页签关闭规则（纯函数，可测）
lib/paging.ts            客户端分页切片（纯函数，可测）
lib/nav-progress.ts      导航 pending 的外部 store
```

## 性能与交互

- **按需引入**：`next.config.ts` 开 `experimental.optimizePackageImports`，Arco 只打进用到的组件。
- **网关压缩**：Next 会压自己的产物，但 API（Hono）的 JSON 不压；`docker/gateway.mjs`
  现在对文本类响应做 gzip（实测订单接口 2131 → 644 字节），尊重 `q=0`，
  跳过事件流与已编码响应，且在 `writeHead` 之前决定，避免 `ERR_HEADERS_SENT`。
- **客户端分页**：列表一次取回后在本地切片，翻页不重新请求。
- **筛选改为「点查询才生效」**：输入过程中不重算整张表，长列表不再逐字符卡顿。
- **交互**：多页签栏、Ctrl/Cmd+K 命令面板、暗色模式（跟随系统并可手动切换）、
  侧栏折叠状态持久化、全屏、路由级 `loading.tsx` 骨架、真实导航进度条。

## 测试护栏的演进

`components/interaction-details.test.tsx` 里两条源码扫描断言原本假设「列头都是手写的
`<th>` / `SortableTh`」。迁移到 Arco Table 后这个假设不再成立，断言已改为：

- 扫描前先剥离注释（避免注释里的标记被当成代码）；
- 排序列头计数 = `<SortableTh` + `sortHeader(`，排序值标注允许落在任意开标签内；
- 阈值从「精确计数」下调为「兜底」，另加一条结构检查：用了 `sortHeader(` 的文件
  必须有排序状态（`useTableSort` / `nextSortState`）。

保留 `SortableTh` 是为了让尚未迁移的手写表格继续受同一套检查约束，而不是为了凑计数。


## 两个容易踩的坑（都是重构中真实撞到的）

1. **Arco 的样式表加载在 `admin.css` / `globals.css` 之后**。覆盖 Arco 组件自身的属性时，
   单类名选择器会被反超（实例：`.app-breadcrumb { display: none }` 压不住
   `.arco-breadcrumb { display: flex }`）。要给覆盖规则加权，例如
   `.app-header .app-breadcrumb { … }`；改 Arco 子元素时用「父类 + Arco 类」这种两级写法
   （`.app-menu .arco-menu-item`）本身就够。
2. **响应式规则必须写在基础规则之后**。同优先级下后者胜出，把 `@media` 放在文件前半部分、
   而基础声明在后半部分，等于媒体查询从未生效（实例：390px 视口下筛选区仍是四列 63px）。
   本项目把所有 `filter-*` 的响应式规则集中在 admin.css 末尾。

## 验收方式

`docker/gateway.mjs` + 本地 mock API（形状对齐组件里声明的类型）可以起一套不连数据库的
完整界面，用 headless Chromium 逐页截图核对；重构期间 15 个管理台页面均做过「零控制台报错」
的全量扫描，并单独核对了移动端（390×844）与登录页。

## 列表页的统一模型

列表页只负责「给列定义 + 给数据」，版式一律由共享层决定，页面里不写宽度、也不写溢出行为。
这一层是 `components/list.tsx` + `admin.css` 的 `.list-table`：

| 层次 | 位置 | 负责什么 |
| --- | --- | --- |
| 内容区 | `admin.css` `.app-content` | `max-width: 1560px` 并居中。没有它，宽屏（2560）上表格会被拉到 2400+，单列「说明」吃掉整屏 |
| 页容器 | `list.tsx` `ListPage` | 一张卡里装筛选 + 表格 + 分页，间距由 `.list-page + .list-page` 统一给 |
| 筛选区 | `.filter-card` / `FilterItem` | 四列网格（≤1200px 两列、≤700px 一列），标签固定宽、控件占满剩余 |
| 工具栏 | `ListCard toolbar` | 计数在左、刷新在右 |
| 表格 | `.list-table` | 表头不换行；单元格换行；标识符（`.mono` / `code`）不换行；**横向溢出只发生在卡片内部，绝不撑宽页面** |
| 分页 | `Pager` | 右对齐、显示总数、可改每页条数 |

**加列时的约定**（这是「统一」的关键，页面各自为政就会回到每页一个样子）：

- 标识符列（订单号、工具名、URL、IP）给固定 `width`，内容用 `.mono` 或 `<code>` 包起来。
  这类值从词中间劈开会直接失去可读性，所以让它们不换行、按内容取宽，放不下时由卡片内部横滚兜底。
- 说明性文本列**不给** `width`，由它吸收剩余空间并换行——写死宽度只会让别的列挤在一起。
- 操作列给固定 `width`，动作用 `<button className="link-button">`，外层 `.row-actions` 不换行。
- 只有 `width` + 单元格内容两件事归页面管，其余（换行、溢出、对齐、层级）都归共享层。
