# 删除消息使用跨设备撤回且不进重试队列；收藏存为 Owner 私有房间级 Account Data

为支持单条已确认消息的**删除消息**与**收藏**功能，确立以下架构与交互边界：**删除消息**通过 `m.room.redaction` 在所有设备永久移除 Owner 或绑定 Agent 发出的已确认消息，不留占位、不让 Agent 遗忘、二次确认后直发且不进重试队列（不可用 Topic 中禁用）；**收藏**存放在 Owner 私有的房间级 Matrix Account Data（`im.waypoint.favorites`），不进重试队列、在不可用 Topic 中仍可用，并在顶栏有收藏时展示带数量的本 Topic 收藏入口。本决定修订 [ADR-0024](./0024-unboxed-document-flow-and-paper-night-theme.md)（顶栏在有至少 1 条收藏时展示收藏入口）与 [ADR-0028](./0028-ios-hig-and-material-3-mobile-ergonomics.md)（长按面板覆盖无说明附件并在桌面端补充悬停 `⋯` 与右键菜单），并衔接 [ADR-0018](./0018-unavailable-topic-indication.md) 与 [ADR-0023](./0023-non-queued-write-failure-and-atomic-room-lifecycle.md)。

## Considered Options

- **收藏沿用 Matrix 标准房间状态 `m.room.pinned_events`（类似 Cinny）**：否决。`m.room.pinned_events` 属于全房间可见状态事件，房间另一成员（绑定 Agent）会在 `/sync` 中读到，违背「收藏只属于 Owner、Agent 看不见、也不是给 Agent 的指令」的边界；且房间状态受 power levels 与不可用状态制约。
- **收藏存放在全局 Account Data 中按 `roomId` 聚合**：否决。单次增删需读写全量 Topic 的收藏映射，且删除 Topic（`leave` + `forget`）后需额外垃圾回收。房间级 Account Data 随房间自然隔离，离开房间后不留孤儿状态，且可通过 `/sync` 的房间 `account_data` 增量同步。
- **删除消息或收藏进入 `RetryQueue` 离线排队乐观生效**：否决。若删除消息离线乐观隐藏后被服务器拒绝，消息会重新冒出；收藏亦属于与「置顶」同类（[ADR-0023](./0023-non-queued-write-failure-and-atomic-room-lifecycle.md)）的 Owner 组织态，采用直发并在失败时保持/回滚原状态加轻量提示最诚实可靠。
- **行为定名为「撤回」**：否决。Owner 亦可删除绑定 Agent 发出的消息，且不留占位、不触发 Agent 遗忘，「删除消息」比「撤回」更准确。

## Consequences

- **删除消息（`m.room.redaction`）**：
  - 仅针对已渲染的已确认消息（含 Owner 与绑定 Agent 发出的纯文字、图片/文件/音视频附件及带审批/选择器消息）；未确认、失败（「丢掉」）与草稿仍走既有路径。
  - 点击「删除消息」先经居中 `AlertDialog` 二次确认；确认后调用 `PUT /_matrix/client/v3/rooms/{roomId}/redact/{eventId}/{txnId}`，得到确认后立即从本地热/冷分块移除事件（同步回退受影响的 `readPositionEventId` 并移除对应收藏），失败则保留原消息并提示。Topic 不可用时禁用删除消息。
- **收藏（`im.waypoint.favorites`）**：
  - 写入 `PUT /_matrix/client/v3/user/{userId}/rooms/{roomId}/account_data/im.waypoint.favorites`（`{ v: 1, favorites: [...] }`，附带轻量摘要、方向与时间戳快照以支撑未加载冷分块列表即时展示），并发防抖并沿用类似 `tagGeneration` 的同步代际锁防止过期 `/sync` 覆盖本地最新修改。
  - `/sync` 或向后分页一旦收到目标事件的 `m.room.redaction` 或 redacted 存根，自动将对应条目从本 Topic 收藏中剔除，不留死条目。
  - Topic 至少有 1 条收藏时，顶栏 `···` 左侧展示带数量的收藏入口；0 条时隐藏以保持 [ADR-0024](./0024-unboxed-document-flow-and-paper-night-theme.md) 极简顶栏。列表按收藏时间倒序展示，支持行内直接取消，点击条目自动按需加载本地冷分块或向后拉取历史并跳回高亮目标气泡。
- **单条消息操作入口**：
  - 移动端窄屏长按 `ActionSheet` 放开对无文字说明附件消息的限制，补齐「收藏 / 取消收藏」与「删除消息」。
  - 桌面端宽屏默认静止态保持纯文档流与干净气泡，不常驻操作按钮；鼠标悬停显示轻量 `⋯` 触发器，并支持对消息右键打开同款 `DropdownMenu`（[ADR-0026](./0026-tailwind-shadcn-and-grok-monochrome-theme.md)）。
