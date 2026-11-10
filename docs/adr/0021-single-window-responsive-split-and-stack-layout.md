# macOS 固定单主窗口与常驻左右分栏，Android 单栏栈式导航，启动不自动打开 Topic

Waypoint V1 在一套共享 React 界面上采用响应式导航布局：macOS 桌面端（宽视口）固定单主窗口并常驻左右双栏（左侧 Topic 列表 + 右侧当前 Topic 对话），Android 移动端（窄视口）采用单栏推入/返回（列表页 ⇄ 对话页）；启动或删除当前 Topic 后不自动默认打开列表首条 Topic。

## Considered Options

- Android 采用侧滑抽屉（Drawer）收纳 Topic 列表，默认停在某个 Topic 对话页。否决：ADR-0001 已定日常主入口是 Topic 列表，且侧滑抽屉在 Android 上极易与系统边缘返回手势冲突。
- macOS 允许折叠隐藏左侧 Topic 列表或切成单栏。否决：桌面端设合理最小窗口尺寸即可常驻主从双栏，保持高频切换 Topic 的效率。
- 启动应用或删除当前 Topic 后自动选中并打开列表第一条 Topic。否决：ADR-0009 已定消息出现在打开的 Topic 屏幕上即推进「已读位置」；若自动打开首条 Topic，会在 Owner 尚未主动点阅时误清首条未读状态。
- macOS 开放多窗口，通过跨窗口广播同步草稿并为 `/sync` 选主。否决：ADR-0005 与 ADR-0010 已定 Matrix 通信层、同步游标、重试队列与草稿都在 WebView 与 IndexedDB 内；多窗口意味着多个独立 WebView 实例同时争抢 `/sync` 游标、重复消费重试队列并在同一 Topic 上并发覆写草稿。

## Consequences

- **双端响应式布局**：
  - **macOS 桌面端（宽视口）**：设置窗口最小尺寸限制，常驻左右双栏（Master-Detail）——左侧固定宽度栏展示 Topic 列表、新建 Topic 与全局设置入口，右侧主区域展示当前打开的 Topic 对话；不提供隐藏左侧栏的单栏模式。
  - **Android 移动端（窄视口）**：采用单栏页面栈推入/返回（Stack Navigation），不做侧滑抽屉——进入应用先见全屏 Topic 列表；点按某条 Topic 推入全屏对话页，通过固定顶栏返回按钮或系统返回手势退回列表页。
- **未选中与空列表状态**：
  - 启动应用或删除当前打开的 Topic 后，不自动替 Owner 打开第一条 Topic。
  - 宽视口未选中任何 Topic 时，右侧对话区展示空白占位引导（提示选择一条 Topic 或提供快捷「新建 Topic」按钮）；窄视口则停留在或退回全屏 Topic 列表页。
  - 当整个 Topic 列表为空时，列表区展示“暂无 Topic”空状态并突出「新建 Topic」入口。
- **macOS 严格单主窗口与草稿无并发**：
  - V1 在 macOS 上全局仅维护唯一主窗口，不提供“新建窗口”或“在新窗口打开 Topic”；点击 Dock 图标或重新激活应用时直接聚焦或恢复该主窗口。
  - 全局仅有一个 WebView 实例运行 TypeScript 通信层（单一 `/sync` 循环、单一重试队列与单一内存草稿状态），切换 Topic 或输入时草稿单向落盘 IndexedDB，不存在多窗口并发覆写同一 Topic 草稿的问题。
