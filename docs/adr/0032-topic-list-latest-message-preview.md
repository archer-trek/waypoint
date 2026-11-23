# Topic 列表行展示最新消息单行预览，列表彻底不显示 Bot 名字

Topic 列表行恢复类似主流 IM 的两行结构：第一行保持 Topic 名字、标签、发送状态与最近活动时刻，第二行展示**本地时间线**最新一条可渲染消息的单行纯文本摘要（与右侧`正在回应`正交共存），并彻底移除列表行中的 Bot 名字显示（单 Bot 与多 Bot 均不展示）。本决定推翻并取代 [ADR-0019](./0019-topic-list-row-unconfirmed-failed-no-preview.md) 的「不展示消息正文预览」决定，同时修订 [ADR-0017](./0017-topic-list-row-timestamp-no-avatar.md) 与 [ADR-0020](./0020-topic-list-unread-indicator-and-pinned-header.md) 中关于多 Bot 副标题显示 Bot 名字的规则。

## Considered Options

- **多 Bot 时在列表保留 Bot 名字（作为第二行元信息形成三行，或拼在预览前/标题旁）**：否决。桌面端侧栏最窄约 256px，第一行已承载 Topic 名字、`不可用`、`置顶`、发送状态与时刻，容不下额外 Bot 标签；将 `Bot 名字` 拼在消息预览前会让 Owner 误以为是消息发送者；而多 Bot 三行、单 Bot 两行会破坏列表节奏。Topic 本身在新建时已由 Owner 命名且绑定关系不可变更，列表彻底不放 Bot 名字使单/多 Bot 结构完全一致、干净紧凑。
- **预览区仅展示已由服务器确认的消息，或连同本机草稿一并显示**：否决。Owner 刚发出**未确认**或**失败**消息后切回列表时，期望看到自己刚发出的内容及配合的转圈/红叹号指示；而**草稿**按 [ADR-0009](./0009-read-position-syncs-drafts-stay-local.md) 仅留在本机输入框，不进入列表预览。
- **在 Owner / Agent 预览前加发送方前缀（如 `我: ` 或 `<Bot名>: `）**：否决。列表已移除 Bot 名字且一对一 Topic 无需在摘要中重复身份标记，直接显示消息内容最简洁。
- **把最新预览冗余持久化进 IndexedDB `StoredRoomMeta`**：否决。绝大多数情况下热窗口（约 50 条事件）内已有最新可渲染消息；仅在热窗口全为撤回或 reaction 时按需逆序回查冷块，可避免调整 IndexedDB schema 及额外写入维护成本。

## Consequences

- **列表行两行固定分工**：
  - **第一行（Header）**：保持 [ADR-0020](./0020-topic-list-unread-indicator-and-pinned-header.md) 左/中/右布局，展示**未读**前导实心圆点与加粗标题、`Topic 名字`（单行截断）、轻量 `不可用` 标签、`置顶` 标记、发送状态（转圈 / 红叹号）与最近活动时刻。
  - **第二行（Secondary）**：单 Bot 与多 Bot 均不展示 Bot 名字；左侧单行省略截断（`truncate`）展示最新消息预览，右侧在存在有效 `👀` reaction 时保留 `• 正在回应` 正交共存。无消息且非**正在回应**时不渲染第二行，无消息时不显示假占位文案，也不回退展示 `Description`。
- **预览派生与格式规则**：
  - 取**本地时间线**（含**未确认**与**失败**本地占位及 `pendingEvents`）中最新一条可渲染消息，不含**草稿**；右侧时刻与列表排序仍严格遵循 [ADR-0017](./0017-topic-list-row-timestamp-no-avatar.md)，不因未确认或失败消息提前更新。
  - 文本消息若存在 `m.replace` 编辑则取最新编辑正文并剥离末尾流式光标 `▉`，清洗 Markdown、Callout 与颜色语法标记并折叠空白为单空格；若清洗后为空则回退到折叠空白后的原正文。
  - 媒体消息使用中文类型标签：`m.image` 显示 `[图片]`（有附言则 `[图片] 附言`），`m.file` 显示 `[文件] 文件名`，`m.audio` / `m.video` 显示 `[音频]` / `[视频]`（有附言或文件名时拼接在后）。
- **冷块回溯（[ADR-0030](./0030-indexeddb-v3-chunked-timeline.md)）**：启动水合、增量同步、冷块卸载或历史加载后，若内存热窗口未命中任何可渲染消息且存在本地冷块，按需逆序扫描本地冷块直到命中最新一条可渲染消息并缓存于内存字段 `coldLatestPreview` 中，不更改 IndexedDB 存储结构。
