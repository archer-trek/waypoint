# 双端用 Tauri 2 和一套 Web UI

Waypoint V1 的 macOS 与 Android 是同一个 Tauri 2 应用。界面是一套 React 代码，跑在 macOS WKWebView 和 Android 系统 WebView 里。Markdown 用 Streamdown、remark-gfm、KaTeX、Shiki。不选 Flutter 或 Compose Multiplatform：要接住的是未闭合的流式 Markdown、表格、代码和公式，这套库只在 Web 渲染管线里是现成的。

## Considered Options

- Flutter。否决：官方 `flutter_markdown` 已停更，表格正是要逃开的问题。
- Compose Multiplatform。否决：表格有了，但没有对等的流式未闭合渲染器。
- 原生列表，只把气泡嵌进 WebView。否决：两套界面，共享边界碎掉。

## Consequences

- Android WebView 版本随设备走，应用不打包 Chromium。
- 软键盘避让必须把 IME inset 传进 WebView。
- 平台差异只留在 Tauri 的系统能力，不另做一套界面。
- V1 不为 Android 系统 WebView 设版本硬门槛。渲染坏了可以提示，不能拒绝打开。
- 渲染插件只开 code、math、cjk，不开 mermaid。
- 消息不在带 Tauri 命令的 WebView 里当 HTML 执行。外链不在应用 WebView 里打开。需要 token 的媒体只走通信层下载。
