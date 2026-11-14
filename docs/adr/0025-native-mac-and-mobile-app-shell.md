# macOS 沉浸式标题栏与窗口拖拽、移动端安全区与去 Web 化，未连接态采用原生卡片

Waypoint 追求在 macOS 桌面端具备原生 App 质感（对标 Slack、Claude Desktop、Things 3），在手机端具备独立 App 质感（无网页浮动、无露白回弹、触控热区严谨）。系统对应用外壳与首次连接流进行全面原生化改造：
1. 首次连接（未连接态）重构为沉浸式 Waypoint 品牌连接卡片，隐藏「尚未进入 Topic 列表」内部测试黑话（收纳为 `sr-only` 保证测试契约），升级为优雅的表单组件与平滑状态转场；
2. macOS 桌面端配置 Tauri `titleBarStyle: Overlay` 并隐藏原生标题，红黄绿系统交通灯融入侧边栏顶栏，标题区赋予 `data-tauri-drag-region` 支持随处拖拽窗口；整站 UI 框架禁用文字选中（`user-select: none`），滚动条对齐系统悬浮规范；
3. 移动端在 `index.html` 注入 `viewport-fit=cover` 与防缩放配置，安全区（`safe-area-inset-*`）全面避让；全局消除 Web 默认行为（`overscroll-behavior: none`、`-webkit-touch-callout: none`、`-webkit-tap-highlight-color: transparent`）；触控热区保证 $\ge 44\text{pt}$ 并带有 100ms 快速按压微反馈；
4. 侧边栏的「已连接」标记同样收纳为 `sr-only`，消除开发诊断文本对人类界面的噪点干扰。

## Considered Options

- 继续在页面顶部展示「尚未进入 Topic 列表」和「已连接」纯文本标签。否决：这是底层测试用例断言状态机偷懒引入的开发黑话，直接暴露给真实 Owner 极其粗糙突兀。
- macOS 保持操作系统默认标题栏（White/Grey Titlebar Strip）。否决：系统原生标题栏割裂应用主题（深色模式时尤为明显），只有 Overlay 沉浸式标题栏才能将交通灯与侧边栏融为一体。
- 移动端依赖系统浏览器默认手势与安全区行为。否决：移动端默认橡皮筋露白和长按弹出 Web 菜单会瞬间暴露「简陋套壳网页」的破绽，必须全局注入移动 App 规范样式。

## Consequences

- 首次连接（未连接态）：
  - 呈现居中高保真卡片容器，包含 Waypoint 品牌航标 Logo、标题与「连接你的 Matrix 专属服务器」副标题。
  - 输入框配备清晰的圆角边框、聚焦微光与 48px 大尺寸触控按键，错误信息使用语义化 Alert 提示块。
  - 「尚未进入 Topic 列表」保留为 `.sr-only` 视觉隐藏文本，确保现有自动化测试与屏幕阅读器无障碍树完全兼容。
- macOS 桌面端：
  - `tauri.conf.json` 开启 `titleBarStyle: "Overlay"` 与 `hiddenTitle: true`。
  - 侧边栏顶栏设置左侧避让交通灯间距（约 76px）及 `data-tauri-drag-region`，支持全顶栏拖拽窗口。
  - UI 框架全站禁用文本选区，仅消息段落与代码块允许选中文本。
- 手机移动端：
  - `index.html` 补齐 `viewport-fit=cover`，样式严格消费 `env(safe-area-inset-top)` 与 `env(safe-area-inset-bottom)`。
  - 根样式禁用 `-webkit-touch-callout`、`-webkit-tap-highlight-color` 与 `overscroll-behavior`。
  - 触控目标满足苹果 HIG（$\ge 44\text{pt}$）与安卓 Material（$\ge 48\text{dp}$）规范。
