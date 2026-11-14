# 采用 Tailwind CSS v4、shadcn/ui 原语体系与 Grokbot 高对比黑白灰 Light/Dark 主题

Waypoint 弃用旧版暖纸色/夜读配色与散落在 `src/App.css` 中的手写样式及自制浮层/确认框实现，全面引入 Tailwind CSS v4 与基于 Radix UI 原语的 `shadcn/ui` 组件体系，统一采用对标 Grokbot 的高对比黑白灰（Neutral/Zinc）Light/Dark 主题，并在「设置 → 这台设备」提供仅作用于本机的外观三档切换，以实现双端稳定一致的原生交互与视觉约束。

## Considered Options

- **继续在单文件 `App.css` 与 `TopicsWorkspace.tsx` 中手写样式、自定义弹窗与颜色变量，或改用暖纸色 + 亮蓝强调色体系**：否决。手写 CSS 与散落的局部类容易导致控件尺寸、焦点环、弹窗遮罩、键盘导航和按压反馈不一致，且暖纸色/亮蓝色块与 Grokbot 的冷冽单色质感背道而驰。
- **使用 Tailwind CSS v3 PostCSS 方案或 Base UI 变体**：否决。当前工程基于 Vite 7 + React 19，Tailwind CSS v4（`@tailwindcss/vite`）可通过 CSS `@theme` 直接映射语义 Token，无需额外 `tailwind.config.js` 维护成本；Radix UI 原语版 `shadcn/ui` 生态成熟，无障碍与焦点管理契约清晰。
- **外观模式仅跟随系统，或通过 Matrix account data 跨设备同步外观设置**：否决。支持本机手动覆盖「浅色 / 深色」便于桌面与移动端随时切换核对；外观偏好属于设备显示习惯而非 Owner 的对话数据，不写入 Matrix 同步。
- **在桌面端或移动端继续将「删除 Topic / 移除 Bot / 退出这台设备」和「编辑 Topic」内嵌在当前页面文档流中，或将移动端「设置 / 新建 Topic」改为底部 Drawer/Sheet**：否决。流内嵌确认块在长页面中容易被遮挡或产生视觉割裂；而移动端改用底部抽屉会与软键盘及 Android 系统边缘返回手势冲突（仍遵守 ADR-0021 的全屏栈式推入原则）。

## Consequences

- **样式与组件基础设施**：
  - 引入 `@tailwindcss/vite`、Radix UI 原语、`class-variance-authority`、`clsx`、`tailwind-merge` 与 `lucide-react` 图标库（保留 Waypoint 专属品牌航标 SVG），配置 `@/*` 路径别名；基础 UI 原语统一收口于 `src/components/ui/`（如 `Button`、`Input`、`Textarea`、`Label`、`Select`、`Dialog`、`AlertDialog`、`DropdownMenu`、`Alert`、`Badge` 等）。
  - 将巨型 `TopicsWorkspace.tsx` 按界面职责拆分为高内聚的独立视图模块；清空 `src/App.css` 中的手写组件样式，仅保留 Tailwind 入口、Grokbot 语义 Token 定义、Tauri macOS 拖拽区与移动端安全区/原生滚动条规则、以及 Streamdown Markdown 文档排版样式。
  - 禁止在业务与 UI 组件代码中硬编码 hex 颜色值，并由自动化检查守卫；同时保留行为测试所需的 `.waypoint-*` 语义钩子与 ARIA 契约，保证既有测试全量通过。
- **Grokbot 高对比黑白灰 Light / Dark 主题**：
  - **浅色（Light）**：纯白主画布（`#ffffff`），次级卡片/代码块/辅助表面为干净浅冷灰（`#f4f4f5` / `#fafafa`），细边框为冷灰（`#e4e4e7`）；Owner 消息气泡、主操作按钮与发送键激活态统一为深炭黑底（`#09090b` / `#18181b`）配纯白字（`#fafafa`）。
  - **深色（Dark）**：纯正深黑/曜石画布（`#09090b` / `#0a0a0a`），悬浮输入盒、弹窗卡片与 Owner 气泡为深锌灰（`#18181b` / `#27272a`），暗灰发丝边框（`#27272a`）；主操作按钮与发送键激活态反转为高对比亮白底（`#fafafa`）配深黑字（`#09090b`）。
  - 彩色仅用于语义状态：「失败」标记、表单报错与破坏性操作确认按钮使用语义红（`destructive`），移除散落的强调蓝与暖米色。
- **本机外观设置与生命周期**：
  - 在「设置」→「这台设备」下提供「外观」三档选择（`跟随系统` / `浅色` / `深色`，默认 `跟随系统`）。
  - 选择结果仅持久化在当前设备本地，切换时实时更新根元素主题类及 `<meta name="theme-color">`，并在「退出这台设备」时随本机数据一并清理。
- **跨端弹窗与交互原语收敛**：
  - **「新建 Topic」「编辑 Topic」「设置」**：桌面宽视口一律采用居中模态窗（`Dialog`），移动窄视口遵循 ADR-0021 保持全屏栈式推入页，双端共用内部 `shadcn/ui` 表单与控件原语。
  - **破坏性二次确认（「确认删除 Topic」「确认移除 Bot」「退出这台设备」）**：在桌面端和移动端一律使用居中遮罩模态确认框（`AlertDialog`）。
  - **操作菜单**：顶栏 `···` 话题操作菜单与失败消息 `⋯` 操作菜单统一采用 `DropdownMenu`。
  - 保留 ADR-0021、ADR-0024 与 ADR-0025 锁定的核心布局与阅读流法则（Agent 无框纯文档流 + Owner 右侧胶囊气泡、贴顶 Docked Header 仅展示 Topic 名与 Description、悬浮自适应大胶囊 Composer 与键盘贴合规则、macOS Overlay 标题栏拖拽与移动端安全区）。
