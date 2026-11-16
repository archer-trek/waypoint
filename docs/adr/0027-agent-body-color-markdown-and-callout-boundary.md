# Agent 正文支持定向行内着色与 GFM Callout，并限定于阅读内容区

在继续严格遵守 [ADR-0007](./0007-render-body-only.md)（只读 `body` 与 `m.new_content.body`，不读 `formatted_body`）和 [ADR-0026](./0026-tailwind-shadcn-and-grok-monochrome-theme.md)（应用 UI 壳层保持黑白灰单色）的前提下，Waypoint 仅在 **Agent 回复（左侧无框文档流）** 中支持定向解析的行内着色标签（`<span style="...">`、`<font color="...">`）与 5 种 GFM Callout（`[!NOTE]`、`[!TIP]`、`[!IMPORTANT]`、`[!WARNING]`、`[!CAUTION]`）；Owner 右侧气泡不启用彩色 Markdown 渲染，非着色类原始 HTML 继续保持纯文本字面量展示。

## Considered Options

- **全局启用 `rehype-raw` 并放宽 `rehype-sanitize` schema**：否决。一旦开启 `rehype-raw`，`<script>` 会被吞掉文本、`<b>`/`<img>`/`<div>` 等标签会被解析成 DOM，破坏既有的纯文本字面量安全契约；同时 `rehype-sanitize` 本身无法按 CSS 声明粒度过滤 `style` 属性。
- **在 Owner 右侧气泡同样启用行内着色与 Callout**：否决。Owner 气泡（浅色模式下为深炭黑底白字、深色模式下为深锌灰底白字）承担轻量发信展示，不需要承担任意颜色与复杂卡片的深底对比度适配，保持普通 Markdown 与纯文本 HTML 行为更简洁可靠。
- **把 5 种 GFM Callout 强行压成 ADR-0026 黑白灰或中文化标题**：否决。5 种语义级别在长文阅读中需要清晰的色彩与图标区分；英文 Title Case（`Note`、`Tip`、`Important`、`Warning`、`Caution`）与 GitHub 业内标准一致，也避免「注意」同时对应 `Note` 与 `Caution` 引起的语义混淆。

## Consequences

- **定向解析而非全局 HTML 注入**：仅识别白名单内的 `<span style="...">` 与 `<font color="...">`（统一归一为安全的 `<span>` 并支持内部嵌套 Markdown），所有其它原始 HTML 标签仍由 Streamdown 默认策略保留为纯文本节点。
- **CSS 声明级清洗与颜色透传**：`style` 属性仅允许 `color`、`background-color` 与 `text-decoration`，拒绝 `url()`、`var()`、`expression()` 及任何布局/交互属性；混合声明时剥离危险声明、保留合法着色声明，并将合法色值在浅色/深色模式下原样透传（与 KaTeX `\color` 一致）。
- **内容区色彩边界（ADR-0026 例外）**：应用壳层（侧栏、顶栏、按钮、表单、输入框等）仍严格遵守 ADR-0026 黑白灰单色约束；新增的 Callout 语义 Token（`Note` 蓝、`Tip` 绿、`Important` 紫，以及复用 `--warning` 黄、`--destructive` 红）仅服务于 Agent 正文阅读区内的 Callout 卡片。
- **GFM Callout 触发与降级**：仅当引用块首行独立为标准 `[!TYPE]`（大小写不敏感）时渲染为带图标与标题栏的 Callout 卡片；未知标记或首行带额外正文时回退为普通引用块，内部正常支持列表、代码块与行内着色。
