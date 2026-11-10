# 新建 Topic 用一次 createRoom；其他没进重试队列的写入没成功就留在原地

进入 Topic 列表后，不进重试队列的管理类写操作（新建 Topic、改名与改 `Description`、名册增删改、置顶/取消置顶、删除 Topic）采用即时交互反馈：表单类操作不做乐观更新，没成功时留在原表单保留已填内容并就地报错；新建 Topic 用一次 `createRoom` 带上初始状态与邀请，`m.direct` 追加尽力而为；置顶没成功就保持或回滚原状态并轻量提示；删除 Topic 以 `leave` 成功为唯一分界线，随后的 `forget` 与 `m.direct` 清理尽力而为。

## Considered Options

- 表单提交时立即关闭弹窗并乐观更新列表，没成功后再弹窗报错并回滚旧值。否决：回滚会丢弃 Owner 刚输入的 Topic 名字或长段 `Description`，留在原弹窗保留输入最便于一键重试。
- 新建 Topic 后若追加 `m.direct` 没成功，将刚建好的房间 `leave` + `forget` 销毁回滚。否决：ADR-0006 已定 Waypoint 仅凭房间状态 `im.waypoint.topic` 识别 Topic，不读 `m.direct`；因兼容性质的 `m.direct` 写入抖动而销毁已成功建好的房间得不偿失。
- 删除 Topic 要求 `leave`、`forget` 与 `m.direct` 全部成功才清理本地数据。否决：一旦 `leave` 成功，Owner 在协议上已离开该房间，按 ADR-0006 列表只收仍在其中的房间；若因 `forget` 没成功而保留本地数据或报错，会导致已离开的房间在本地残留僵尸状态。

## Consequences

- **表单型写操作（新建 Topic、改名与改 `Description`、名册增删改）**：
  - 提交期间锁定提交按钮（loading 态），不在服务器确认前做乐观更新。
  - 若断网或被 Homeserver 拒绝，表单/弹窗保持打开，完整保留 Owner 已填内容并就地显示错误提示，由 Owner 再次点击提交重试。
  - 编辑 Topic 时仅对实际变更的字段（`m.room.name` / `m.room.topic`）发请求；若同时改名字与 `Description`，一项成功、一项没成功，已成功的一项立即生效，弹窗保持打开并仅针对未成功的一项保留输入与报错，重试时只补发未成功项。
- **新建 Topic 的一次 createRoom 与异常处理**：
  - 调用 `POST /createRoom` 时在单次请求中一并传入 `name`、非空 `topic`（`Description`）、`initial_state`（含 `im.waypoint.topic` 标记）、`invite: [agentUserId]` 与 `is_direct: true`。`createRoom` 失败时服务器无房间残留，直接留在弹窗内报错。
  - 若服务器违背请求，在新建时强制开启加密，按 ADR-0006 立即尽力 `leave` 再 `forget`，不进列表并在弹窗报错；若分离邀请失败，房间已带标记，进入列表并呈现为 `不可用`。
  - `createRoom` 成功后该 Topic 即新建成功并打开；随后向 Owner 的 `m.direct` 追加房间 ID 作为尽力而为（best-effort）步骤，没成功也不报错、不回滚已建 Topic。
- **置顶与取消置顶**：
  - 操作 `m.tag` `im.waypoint.pinned` 期间防抖禁用重复点击；若请求没成功，保持或立即回滚至原置顶状态与原排序位置，并以轻量提示（Toast / 横幅）告知没成功。
- **删除 Topic 的成败分界与清理**：
  - 二次确认后先调用 `POST /rooms/{roomId}/leave`。
  - 若 `leave` 没成功：删除未生效，不清空该 Topic 在 IndexedDB 中的「本地时间线」、「草稿」与「重试队列」，Topic 留在列表中并在确认弹窗/界面提示错误供重试。
  - 一旦 `leave` 成功：立即将该 Topic 从列表移除，并清除其「本地时间线」、「草稿」与「重试队列」；随后的 `POST /rooms/{roomId}/forget` 与从 `m.direct` 移除该房间 ID 均作为后台尽力而为收尾，即便没成功也不报错、不回滚。
