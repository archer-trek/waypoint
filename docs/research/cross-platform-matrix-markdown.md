# macOS + Android 跨端技术栈、富 Markdown 与非加密 Matrix 接入

用途：为 [选定 macOS 与 Android 跨端技术栈及 Matrix 通信层架构](https://github.com/archer-trek/waypoint/issues/7) 提供一手对比。约束来自 [Waypoint V1 架构与产品决策地图](https://github.com/archer-trek/waypoint/issues/2)：单 `Owner`、一对一 `Agent`、macOS 与 Android 都要、房间 E2EE 不在 V1、核心体验是流式富 Markdown（代码高亮与复制、GFM 表格、KaTeX、可折叠思考/工具卡片）。

本文件只记录事实与可观察的代价，不替决策单做最终选型。

## 1. 流式富 Markdown

Waypoint 要渲染的不是静态文档，而是 Hermes 每隔约 0.8 秒用 `m.replace` 整篇替换的未完成 Markdown，外加可能被从代码围栏或表格中间切开的 15KB 分片。渲染器必须能在围栏未闭合、表格行未写完时不把后文吞进代码块。

### 1.1 Web 渲染管线（Tauri v2 可用）

Tauri 2 不自带浏览器。macOS 用系统 WKWebView；Android 用系统 WebView（Chromium），版本取决于设备当前选中的 WebView provider，应用不打包 WebView。

来源：[Tauri Webview Versions](https://tauri.app/reference/webview-versions/)。

这条路线可以直接用为 AI 流式设计的 React 渲染器，而不是通用 Markdown 预览：

- [Streamdown](https://github.com/vercel/streamdown) 自称 `react-markdown` 的替代，专门处理未闭合围栏和流式 token。官方文档列出代码、Mermaid、数学（KaTeX）和 CJK 插件：`@streamdown/code`、`@streamdown/math`。
- 同一生态里的 `remark-gfm`、`rehype-katex`、`shiki` 覆盖 GFM 表格、公式和语法高亮。代码块复制是 DOM 能力，不需要自绘文本选择。

代价：

- Android 系统 WebView 版本不可控。旧 WebView 上的 CSS sticky、复杂表格横向滚动、`interactive-widget=resizes-content` 软键盘避让都可能和桌面 WKWebView 不一致。Tauri 文档明确版本由设备决定。
- 流式整篇替换若每次都卸载整棵 Markdown 树，光标和滚动锚会跳。Streamdown 的卖点就是缓解这件事，但仍要在真机上验证 0.8 秒全量 `m.replace`，而不是只验证 token 增量。
- 包体小是 Tauri 相对 Electron 的公开主张（系统 WebView，不打包 Chromium）。Android 上这同时意味着不能假设 Chromium 版本。

### 1.2 Flutter

Google 维护的 `flutter_markdown` 已于 2025-04-30 停止更新。Flutter issue [#162966](https://github.com/flutter/flutter/issues/162966) 与包 README 都写了停更日期。社区接续包是 `flutter_markdown_plus`。

来源：[flutter/flutter#162966](https://github.com/flutter/flutter/issues/162966)，[flutter_markdown_plus README](https://github.com/foresightmobile/flutter_markdown_plus/blob/main/README.md)。

表格是这条路线的已知缺口，而且正好是用户现在的痛点：FluffyChat（Flutter Matrix 客户端）issue [#2918](https://github.com/krille-chan/fluffychat/issues/2918) 写明 Markdown 表格显示成原始文本，并指出 `flutter_markdown` 原生表格支持有限，要靠第三方扩展。Waypoint 若选 Flutter，等于接手 FluffyChat 没做好的那一层，而不是绕开它。

公式需要另接 `flutter_math_fork` 一类包，和 Markdown 组件的高度测量是两套布局。流式 `m.replace` 会让可变高度的 `ListView` 反复 relayout。代码块内选词复制在自绘文本里比 DOM 选择更难做对，尤其是围栏和普通段落混排时。

### 1.3 Compose Multiplatform

[multiplatform-markdown-renderer](https://github.com/mikepenz/multiplatform-markdown-renderer) 用 Compose 把 Markdown 画成原生组件，README 写明会处理表格。历史 issue [#99](https://github.com/mikepenz/multiplatform-markdown-renderer/issues/99) 曾报告表格不出现、分隔线把字号撑大；后续 release 修过 GFM math span 被丢掉、只剩纯文本的问题，也有独立 LaTeX 模块的 PR。

来源：[README](https://github.com/mikepenz/multiplatform-markdown-renderer/blob/develop/README.md)，[issue #99](https://github.com/mikepenz/multiplatform-markdown-renderer/issues/99)，[releases](https://github.com/mikepenz/multiplatform-markdown-renderer/releases)。

相对 Web，这条线的代码高亮、未闭合围栏、KaTeX 和流式增量缓存都要自己拼。macOS 桌面 Compose 可用，但没有 Tauri/Web 那套现成的 AI 流式 Markdown 库。

### 1.4 对照

| 能力 | Tauri + Web（Streamdown / remark-gfm / KaTeX / Shiki） | Flutter（`flutter_markdown` 已停，`flutter_markdown_plus`） | CMP（mikepenz renderer） |
| --- | --- | --- | --- |
| GFM 表格 | 成熟 | 官方包弱；FluffyChat 已踩坑 | 现已声明支持；旧版有过不渲染 |
| 代码高亮与复制 | Shiki + DOM 选择 | 需自绘，复制是已知难点 | 需自绘 |
| KaTeX | 一等插件 | 外挂 math 包，布局分离 | 有 LaTeX 模块，覆盖度仍在追 |
| 未闭合流式 Markdown | Streamdown 的设计目标 | 无对等的流式专用渲染器 | 无对等库 |
| 双端观感一致性 | Android WebView 版本漂移 | 自绘，两端更一致 | 自绘，两端更一致 |

## 2. 非加密 Matrix Client-Server 接入

V1 不做 Olm/Megolm。Personal Agent 客户端实际要打的是一小撮已认证的 Client-Server 端点，不是完整 IM SDK。

### 2.1 最小端点

规范依据：[Client-Server API](https://spec.matrix.org/unstable/client-server-api/)，[v1.11 changelog / MSC3916](https://spec.matrix.org/v1.16/changelog/v1.11/)，[Matrix v1.11 发布说明](https://matrix.org/blog/2024/06/20/matrix-v1.11-release/)。

| 用途 | 端点 |
| --- | --- |
| 登录 | `POST /_matrix/client/v3/login` |
| 增量同步 | `GET /_matrix/client/v3/sync`（`since`、`timeout`、`filter`） |
| 建 2 人房间 / 邀请 | `POST /_matrix/client/v3/createRoom`，`POST /_matrix/client/v3/rooms/{roomId}/invite` |
| 发文本、编辑、表情 | `PUT /_matrix/client/v3/rooms/{roomId}/send/{eventType}/{txnId}`。文本是 `m.room.message`；编辑是带 `m.relates_to.rel_type = m.replace` 与 `m.new_content` 的新事件；表情是 `m.reaction` + `m.annotation` |
| 撤回表情 | `PUT /_matrix/client/v3/rooms/{roomId}/redact/{eventId}/{txnId}` |
| 正在输入 | `PUT /_matrix/client/v3/rooms/{roomId}/typing/{userId}` |
| 房间名 / topic / `m.direct` | state 与 `PUT /_matrix/client/v3/user/{userId}/account_data/{type}` |
| 下载媒体 | homeserver 声明 v1.11 后必须用 `GET /_matrix/client/v1/media/download/{serverName}/{mediaId}`，**要带 access token**。旧的 `/_matrix/media/*` 下载已弃用 |
| 上传媒体 | v1.11 尚未把 `/upload` 迁走，仍是 `/_matrix/media/v3/upload`，且需要认证。发布说明写明 upload 的迁移留到后续版本 |

Hermes 自己的媒体 URL 转换已经指向认证端点：`{homeserver}/_matrix/client/v1/media/download/{mxc without scheme}`。

来源：[adapter `_mxc_to_http`](https://github.com/NousResearch/hermes-agent/blob/90d6b98fd86d20981ee06ddd5b7d93e4320f26a4/plugins/platforms/matrix/adapter.py#L3012-L3015)。

不需要的：设备密钥上传、`/keys/query`、Olm session、cross-signing、encrypted to-device。这些是 E2EE SDK 的体积和复杂度来源。

### 2.2 自研薄 HTTP 层 vs 现成 SDK

| | 薄 HTTP 客户端 | `matrix-rust-sdk` | `matrix-js-sdk` | Dart `matrix` |
| --- | --- | --- | --- | --- |
| 适合的壳 | 任意。Tauri 放 Rust，Flutter/CMP 放各自 HTTP 栈 | Rust，经 UniFFI 绑到 Kotlin/Swift；对 Tauri 最自然 | 只在 JS/WebView 里顺 | 只在 Flutter 里顺 |
| E2EE | 不实现，符合 V1 | 默认能力，关掉仍拖着加密栈与存储 | 同样以加密客户端为主 | 同样 |
| 对 `body` / `formatted_body` / 原始 `m.replace` 的控制 | 完全 | 可以，但要绕过 SDK 的时间线模型 | 可以，时间线模型很重 | 可以 |
| 双端编译 | 无 FFI | Android/macOS 交叉编译和 UniFFI 是主要成本 | Tauri 容易，Flutter/CMP 别扭 | Flutter 容易，其他壳别扭 |
| 包体 | 一个 HTTP 客户端 | 显著大于薄客户端 | JS 包大，但是解释执行 | 中等 |

V1 的协议面（登录、sync、建房、发事件、反应、redact、认证媒体、account data）用各语言标准 HTTP 客户端就能覆盖。引入完整 SDK 的收益主要是「以后要开 E2EE 时少重写」，而这张地图已经把 E2EE 划在范围外。若决策单仍想留 E2EE 后路，`matrix-rust-sdk` 是唯一一条以后不用换语言的路，但 V1 会为用不到的加密存储付编译和包体成本。

## 3. 双端交互工程

### 3.1 反向列表与滚动锚定

流式编辑会改变最后一条气泡的高度。无论哪条技术栈，列表都必须钉在底部：用户没往上翻时，高度变化不把视口顶走；用户在看历史时，不把视口拽回底部。Web 用 overflow anchor / scroll pinning；Flutter 用 `CustomScrollView` + anchor；Compose 用 `LazyColumn` reverse layout。这是实现成本，不是某一框架缺失的 API。真正拉开差距的是 Markdown 高度测量：DOM 在一次替换后能给出新高度；Flutter/Compose 要等子树 layout，未闭合表格和公式更容易跳。

### 3.2 Android 软键盘

系统 WebView 的默认 resize 经常盖住输入框。可靠做法是 Android `WindowInsets` 把 IME inset 传进 WebView，或在 manifest 里使用 `interactive-widget=resizes-content`（API 30+）。Tauri 的 Android 壳必须显式做这件事，不能假设 WKWebView 的桌面行为会在 Android 上复现。Flutter 与 Compose 有一等的 `WindowInsets` / `imePadding`，这是它们相对 WebView 的确定优势。

### 3.3 macOS 快捷键、粘贴与拖拽

Tauri 2 把剪贴板、文件拖拽和全局快捷键做成了原生插件，粘贴截图和拖文件进输入框不需要自绘。Flutter macOS 与 Compose Desktop 也能做，但文件拖拽和富文本剪贴板要写平台通道。对一个以「把代码和截图丢给 Agent」为主的桌面端，这条成本偏向 Tauri。

### 3.4 安装包

Tauri 不打包浏览器引擎，macOS 包体通常远小于 Flutter/CMP 的自绘运行时加 Skia。Android 包体优势没那么大，因为系统 WebView 之外仍要带 Rust 运行时和前端资源，而 WebView 版本碎片是隐藏成本。

## 4. 对决策单有用的事实边界

- 若选型标准是「把 Hermes 的流式 Markdown、表格、代码、公式一次做对」，Web 渲染管线的现成库最完整，FluffyChat 的表格 issue 说明 Flutter 官方 Markdown 包没有解决用户正在逃开的问题。
- 若选型标准是「Android 软键盘、手势和自绘一致性优先，且接受自己做表格/公式/流式增量」，Flutter 或 CMP 更可预期，但 V1 的核心痛点正好在渲染，不在壳。
- 非加密接入不需要 Matrix SDK。薄 Client-Server 客户端足够，并且更容易只消费 `body` Markdown、把 `m.replace` 收成一条气泡。SDK 的价值只在未来把 E2EE 拉回范围时才成立。
