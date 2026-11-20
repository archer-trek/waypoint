# IndexedDB v2 多 Store 细粒度持久化与草稿防抖

为彻底消除单 key 整库覆写带来的严重写放大、大对象深拷贝耗时与按键打字队头阻塞，耐久状态存储由单一 `records` store 升级为 7 个专门用途的 Object Stores；时间线与房间元数据物理拆离；本地二进制附件抽离为单份 `blobs` 按需异步加载；统一「先 commit 事务再更新内存」原则；草稿文本采用 400ms 防抖合并并在离开编辑态时强制 Flush，配合 `draftSeq` 版本号杜绝幽灵草稿复活；冷启动异常提供带二次确认的可恢复清库路径。

## Considered Options

- 保持单一 `records["session"]`，仅在 JS 内存层加防抖与局部更新缓存。否决：无法从根本上消除写放大，任何微小变更（如推进已读位置、修改置顶标签）仍会在序列化写入时克隆全库所有房间事件与附件字节；且无法支撑未来的按需与细粒度加载。
- 引入 SQLite（通过 Tauri 插件）替代 IndexedDB。否决：ADR-0010 已定耐久状态留在 WebView 的 IndexedDB，无需跨 FFI 引入冗余驱动与多一层序列化开销，双端 WebView 的原生沙盒已受操作系统持久保护。
- 本地附件直接使用 `Blob` 类型存储。否决：调研显示 WebKit 底层对 `Blob` 拆分独立磁盘文件存在历史稳定性缺陷，且在 Node/Vitest `fake-indexeddb` 环境中读取需额外异步转换；采用单份原生 `Uint8Array` 跨端表现最一致、结构化克隆开销仅数毫秒且零格式转换损耗。
- 草稿持续无防抖按键直写。否决：快速打字时每次按键均排入持久化队列，严重阻塞 `/sync` 同步、消息发送与已读标记更新，并导致大量无意义磁盘 I/O。

## Consequences

- **7 个 Object Store 划分与时间线解耦**：
  - `meta`: 固定单 key `"session"` 存会话级状态（`baseUrl`, `userId`, `accessToken`, `deviceId`, `syncCursor`, `accountData`）。`dropCredential` 仅写该 store。
  - `rooms`: 按 `roomId` 存 Topic 状态元数据（`stateEvents`, `tags`, 已读指针, `backwardToken`, `reachedStart`, `timelineGap`/`timelineGaps`, `encryptedIrreversible`, `inviteFailed`）。
  - `timelines`: 按 `roomId` 存消息事件列表（`timelineEvents`，不含二进制字节，仅存附件引用与元数据）。推进已读位置、更新 Topic 名称/Description、置顶时不再覆写或序列化该 Topic 的整段事件列表。
  - `drafts`: 按 `roomId` 存 `{ text?, attachmentId?, attachmentMeta? }`。
  - `pending_events`: 按 `txnId`（索引 `roomId`）存待确认/重试消息与 reaction，增删单条消息变为 O(1)。
  - `pending_read_markers`: 按 `roomId` 存 `{ roomId, eventId }`。
  - `blobs`: 按 `attachmentId` 存 `{ id, name, mimeType, size, data: Uint8Array }`。
- **内存附件按需异步加载与单份生命周期**：
  - `MatrixClient` 内存仅保留 `attachmentId` 与轻量元信息，不长期持有 `Uint8Array` 字节；仅在上传或 Owner 点开大图时按需异步读取 `blobs`。
  - 附件自草稿选入起分配全局唯一 `attachmentId`，发送时引用直接流转至待发事件与时间线占位，全程无双份存储；确认收到、丢弃失败消息、清空草稿或删除 Topic 时级联清理。
- **一致性与写盘失败退避**：
  - 所有写操作必须 `await tx.oncomplete`；严格「先 commit 事务成功，再修改内存状态」。
  - 发消息写盘失败（`QuotaExceededError`）保留输入框草稿，不进本地时间线并内联报错；`/sync` 写盘失败不推进游标，指数退避（5s → 15s → 30s）并连败 3 次顶栏静默警告；已读位置与草稿防抖静默重试；配置类操作即时回滚提示。
- **草稿防抖与防陈旧回写**：
  - 文本输入 400ms 防抖合并；在 Topic 切换、输入框 `blur`、`visibilitychange(hidden)`、`pagehide` 与组件卸载 5 处时机立即强制 Flush；附件增删立即原子写入。
  - 单调递增 `draftSeq`，防抖定时器执行时严格比对版本号，废弃陈旧回调，杜绝幽灵草稿复活。
- **平滑升级与异常自愈**：
  - v1→v2 在 `onupgradeneeded` 内微任务同步拆解并删旧表，遇异常自动回滚；启动时轻量清理孤儿 blobs。
  - 保留 `loadSession()` 与 `saveSession(session)` 兼容门面支持既有测试；`WeakMap<IDBFactory>` 隔离连接。
  - 冷启动异常渲染专用恢复页，提供「重试」与带二次确认的清库入口（`deleteDatabase`）。
