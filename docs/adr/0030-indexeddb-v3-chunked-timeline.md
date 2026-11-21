# IndexedDB v3 时间线分块存储与热窗口按需水合

为消除长 Topic 增量同步与本地占位写入时覆写整条时间线数组的开销，并避免启动水合把所有 Topic 的全部本地时间线一次性载入内存，耐久状态存储由 v2 的整条 `timelines` 升级为 v3 的有序分块 `timeline_chunks`（每块目标约 50 条事件，与 `BACKFILL_PAGE_LIMIT` 对齐）。启动仅水合每个 Topic 的最新热窗口及全部未确认/失败占位消息；向上翻页或打开有未读的历史 Topic 时优先从本地 IndexedDB 按需加载冷块，耗尽后再向 Homeserver 发起 `/messages?dir=b`；切离 Topic 时释放内存冷块并完整保留 IndexedDB 分块，**保持 ADR-0010「V1 不淘汰本地时间线」不变**。

## Considered Options

- 为本地时间线设置固定上限并在后台自动淘汰较早的已确认事件（修删 ADR-0010）。否决：会破坏离线状态下完整本地时间线的持久可用性，并引入跨未读位置淘汰、`m.replace` / `m.reaction` 悬空与 `backwardToken` 回退一致性复杂度；当前问题可通过分块存储与按需加载解决，无需淘汰本地历史。
- 维持 v2 单 key `timelines[roomId]` 存储，仅在内存中切片截断。否决：每次 `/sync` 追加或本地消息状态变更仍会克隆并覆写整条时间线数组，无法消除长 Topic 的磁盘写放大。
- 按固定时间窗口（如按天）分块。否决：活跃度极不均匀的 Topic 会产生极大或极小的分块；按固定事件条数（~50 条，结合 `[roomId, seq]` 复合有序键）能够稳定控制单次读写与渲染粒度，并与 `BACKFILL_PAGE_LIMIT` 自然对齐。

## Consequences

- **Schema 升级（v2 → v3）与分块结构**：
  - `DB_VERSION` 升至 `3`，新增 `timeline_chunks` store（`keyPath: ["roomId", "seq"]`，建有 `roomId` 索引），删除旧 `timelines` store。
  - v2 → v3（及 v1 → v3）在 `onupgradeneeded` 内事务同步完成迁移，按尾对齐每块约 50 条切分历史事件并回填摘要元数据；异常自动 `abort` 回滚，不丢事件、草稿、重试队列或 `blobs` 附件。
  - 保留 `loadSession()`、`saveSession()` 与 `loadV2Snapshot()` 兼容门面供测试使用；`MatrixClient.restore()` 改为调用 `loadStartupSnapshot()`。
- **`StoredRoomMeta` 摘要元数据与边界追踪**：
  - 持久化 `lastActivityTs`、`chunkMinSeq`、`chunkMaxSeq`、`placeholderChunkSeqs` 与 `readPositionInLocal`，使 Topic 列表排序与启动判定无需全表扫描历史分块。
- **增量尾部写入与历史前插隔离**：
  - `/sync` 追加及本地占位生命周期（`saveEnqueuedEvent`、`saveUploadedMediaUrl`、`saveConfirmedEvent`、`saveFailedEvent`、`saveResendEvent`、`saveDiscardFailedEvent`、`saveSyncBatch`）仅写受影响的尾部或目标分块，不重写更早的历史分块。
  - `applyBackfillPage` 向前追加历史时写入新的前序分块（`seq` 递减），向中间 `limited` 缺口插入时仅局部切分目标分块并分配严格递增的中间 `seq`，不扰动其余较新分块。
- **热窗口水合、未读精确判定与内存裁剪**：
  - 启动水合仅将每个 Topic 最新热块（~50 条已确认事件）与所有 `unconfirmed` / `failed` 占位载入内存。
  - 当 `readPositionEventId` 不在热块内时：若 `readPositionInLocal === true` 且热块已含可渲染的 Agent 消息，则直接确定 `unread: true`；否则按需逆序读取本地冷块直到命中 `readPositionEventId` 或确认存在未读 Agent 消息，保证列表中未读圆点与 `readPositionUnknown` 100% 准确。
  - 打开未读缺口或向上滚动（含视口未填满自动补齐）时，先从 IndexedDB 加载相邻本地冷块；仅在本地冷块全部加载后才向 Homeserver 请求 `/messages?dir=b`。
  - 切换离开当前 Topic 时调用 `unloadColdChunks` 将内存裁剪回热窗口并保留 `coldUnreadState`，同时完整保留 IndexedDB 中的所有分块。
- **跨分块撤回、编辑与回应**：
  - `/sync` 收到指向未加载冷块事件的 `m.room.redaction` 时，在 `retainSync` 事务前定位对应冷块并按既定规则移除被撤回事件（或为 prompt reaction 保留 `unsigned.redacted_because` 标记），随同一批 `saveSyncBatch` 原子提交。
  - 指向冷块消息的 `m.replace` 与 `m.reaction` 正常写入最新分块；当目标冷块按需载入内存后，`deriveRoomTimelineItems` 自动完成合并渲染。
