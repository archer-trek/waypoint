# 打开 Topic 时在顶部标题栏第二行恢复展示绑定 Bot 名字

打开 Topic 后，顶部固定标题栏恢复展示当前 Topic 所绑定的 Bot 名字（单 Bot 与多 Bot 均显示），置于标题下方第二行，并与可选的 `Description` 合并为紧凑两行结构；Topic 列表行继续保持 [ADR-0032](./0032-topic-list-latest-message-preview.md) 不展示 Bot 名字的决定，编辑 Topic 页也不重复展示只读 Bot 字段。本决定修订 [ADR-0024](./0024-unboxed-document-flow-and-paper-night-theme.md)（及 [ADR-0026](./0026-tailwind-shadcn-and-grok-monochrome-theme.md) 对应表述）中「Bot 不进顶栏」的规则，并与 [ADR-0020](./0020-topic-list-unread-indicator-and-pinned-header.md) 固定吸顶顶栏衔接。

## Considered Options

- **将 Bot 名字作为小徽章放在第一行 Topic 名字右侧**：否决。移动窄屏（约 390px）顶栏去掉返回与 `···` 按钮后中部宽度仅约 250px，同行塞入 Bot 标签会严重挤压并截断 Topic 标题。
- **固定分为三行（第一行 Topic 名字、第二行 Bot 名字、第三行 Description）**：否决。在移动端与软键盘弹起时会额外拉高常驻吸顶顶栏，压缩对话可视高度。
- **同时在 Topic 列表行恢复 Bot 名字，或在编辑 Topic 页补充只读 Bot 字段**：否决。列表行需保持 [ADR-0032](./0032-topic-list-latest-message-preview.md) 的两行紧凑预览节奏；顶栏已常驻展示绑定 Bot，编辑页无需重复信息。

## Consequences

- **顶栏紧凑两行布局**：
  - 第一行独享完整宽度展示 **Topic 名字**（保持既有字号、加粗与单行截断）。
  - 第二行以次级文字（13px）展示按「手写名 → 显示名 → localpart」解析的 **Bot 名字**（不显示完整 Matrix 用户 ID）；若该 Topic 同时有非空 `Description`，折叠态在同一行内以 `Bot 名字 · Description` 紧凑单行展示，点按 `Description` 展开时换行完整展示在 Bot 名字下方。
  - 当 Topic 绑定不合法（`botDisplayName` 为空）时不编造名字，遵循 [ADR-0012](./0012-bubbles-by-side-day-separators.md)，此时第二行仅在有 `Description` 时渲染 `Description`。
- **边界不变**：Topic 列表行仍彻底不展示 Bot 名字；顶栏吸顶样式、不放头像及右侧 `···` 话题操作菜单规则继续生效。
