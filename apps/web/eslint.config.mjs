// ESLint 配置（apps/web）
//
// 刻意保持最小集。这个仓库的可访问规范里，通用部分交给这里的插件，
// 项目特有的部分（Arco 覆盖加权、data-sort-value 标注、图标 aria-hidden）
// 继续由 components/interaction-details.test.tsx 的源码扫描守护 ——
// lint 插件懂 JSX，不懂本仓库的 CSS 分层约定。
//
// 不引入的规则，以及原因：
//   - react-hooks：本项目用了不少刻意规避 effect 重跑的写法
//     （lib/api.ts 的 resolvedPathRef 就是典型：依赖里放 ref 会每次成功都重跑请求），
//     插件的 exhaustive-deps 会与这些设计长期打架，误报率高于收益。
//   - typescript-eslint 的 no-unused-vars 之类：tsc --noEmit 已经拦掉了，
//     这里只保留两处能补充说明的特例（见下方注释）。

import js from "@eslint/js";
import tseslint from "typescript-eslint";
import jsxA11y from "eslint-plugin-jsx-a11y";
import { globalIgnores } from "eslint/config";

// Arco 的输入类组件（Input / Input.Password / Input.TextArea / Select / DatePicker …）
// 渲染出来的都是真正的表单控件，只是标签名不是原生 <input>/<select>。
// label-has-associated-control 默认只认识原生小写标签名，不告诉它就会把本项目
// 大量正确的「<label>文字<Input/></label>」隐式关联误报成错误。
// 组件实例没有 EXACTLY 匹配的写法，这里用前缀覆盖：凡是这些组件名开头的都算控件。
const ARCO_CONTROLS = ["Input", "InputNumber", "Select", "Switch", "DatePicker", "TimePicker", "AutoComplete", "Cascader", "TreeSelect", "Mention", "Checkbox", "Radio", "Rate", "Slider", "Upload"];

export default tseslint.config(
  globalIgnores([
    // Next 构建产物与本地产物，不是源码
    ".next/**",
    "node_modules/**",
    "next-env.d.ts",
    "tsconfig.tsbuildinfo",
  ]),

  {
    files: ["**/*.{ts,tsx}"],
    extends: [js.configs.recommended, tseslint.configs.recommended, jsxA11y.flatConfigs.recommended],
    languageOptions: {
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
      },
    },
    rules: {
      // ---- 本次引入的核心目标：把已在测试里固定的规范部分下沉到 lint ----
      //
      // 1) 标签必须关联控件。<label>文字</label><Input/> 这种写法会让屏幕阅读器
      //    念到没有名字的输入框，点文字也不能聚焦控件（FilterItem 那类 bug）。
      // 注意：这条规则只认原生小写 <input>/<select>，对本项目大量使用的
      // 「<label>文字<Input/></label>」天生判不出来，必须显式告诉它 Arco 的
      // 输入类组件也算控件。剩下一种它看不见的情况是自定义包装组件
      // （FilterItem / NumberField：label 是组件返回的，不是属性），
      // 那种用下面的 FilterItem 专项豁免处理。
      "jsx-a11y/label-has-associated-control": ["error", {
        controlComponents: ARCO_CONTROLS,
        assert: "either",
        depth: 3,
      }],
      // 2) <img> 必须有 alt（本项目几乎没有 <img>，零成本兜底）。
      "jsx-a11y/alt-text": "error",
      // 3) ARIA 属性名/值必须真实存在，拼错（aria-lable）会静默失效。
      "jsx-a11y/aria-props": "error",
      // 4) role 上挂的属性必须是该角色支持的。
      "jsx-a11y/role-supports-aria-props": "error",
      // 5) 非交互元素（div/span）挂 onClick / tabIndex，键盘用户无法操作。
      //    本项目全部用原生 <button>，正常应该是零报错。
      "jsx-a11y/no-static-element-interactions": "error",
      "jsx-a11y/click-events-have-key-events": "error",
      "jsx-a11y/no-noninteractive-tabindex": "error",

      // ---- 关掉的规则与原因 ----
      //
      // no-autofocus：本项目的 autoFocus 全部落在 Arco <Modal> 上，配合 focusLock
      // 把焦点移进对话框 —— 这正是对话框该做的事（焦点必须离开背景内容），
      // 跟「页面加载就抢焦点」是两回事。规则分不清这两者，误报 12 处。
      "jsx-a11y/no-autofocus": "off",

      // ---- 少量真有价值的 JS 规则 ----
      // 空 catch 是故意留的（剪贴板回退、主题脚本兜底都靠它），放行；
      // 但空 if / 空函数体通常意味着分支漏写了。
      "no-empty": ["error", { allowEmptyCatch: true }],
      "prefer-const": "error",
      // any：本项目在 lib/api.ts 的 JSON 解析处刻意用了 any（外部响应结构不可知），
      // 保留规则但允许局部豁免写理由。
      "@typescript-eslint/no-explicit-any": "error",
      // 下划线前缀未使用变量是「故意解构出来占位、不使用」的约定，放行。
      "@typescript-eslint/no-unused-vars": ["error", {
        varsIgnorePattern: "^_",
        argsIgnorePattern: "^_",
      }],
    },
  },

  // Tabs / hover-detail 的两条豁免（common.tsx）。
  //
  // interactive-supports-focus：WAI-ARIA APG 的 tabs 模式规定「只有当前 tab 可 Tab 聚焦，
  //   组内用方向键切换」（roving tabindex），tablist 容器本身不该进 Tab 序列 ——
  //   插件按「有 role 就该可聚焦」的旧认知误报。本项目实现的正是 APG 规范，
  //   interaction-details.test.tsx 里 roving tabindex 的测试也守着这一点。
  // no-noninteractive-tabindex：hover-detail 的 span 故意可聚焦，
  //   为了让键盘用户 focus 时也能看到补充说明（onFocus/onBlur 已配对处理）。
  {
    files: ["**/common.tsx"],
    rules: {
      "jsx-a11y/interactive-supports-focus": "off",
      "jsx-a11y/no-noninteractive-tabindex": "off",
    },
  },

  // FilterItem 的专项豁免。
  //
  // label-has-associated-control 看不见组件内部：<FilterItem label="关键字"><FilterInput/></FilterItem>
  // 里真正的 <label> 与控件都是 FilterItem 自己渲染出来的，插件只看到「FilterItem 既不是
  // 原生 label、也没有控件子节点」，于是把 12 个页面里 27 处正确写法全报成错误。
  // 根本管不住 —— 它无法跨组件边界看结构。
  //
  // 之所以敢放行：FilterItem 的关联由 components/modal-form-layout.test.tsx 的
  // 「文案与控件都写在同一个 label 里」守着（那条测试会断言 {children} 确实嵌套在
  // <label> 内），加上 Playwright 实测过 labelAssociated: true。也就是说这条规则在这里
  // 只会漏报 FilterItem 自身被改坏的情况，而那件事已由另一种手段覆盖。
  {
    files: ["**/*.tsx"],
    ignores: ["**/list.tsx"],
    rules: {
      "jsx-a11y/label-has-associated-control": "off",
    },
  },
);
