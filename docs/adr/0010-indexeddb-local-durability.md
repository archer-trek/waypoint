# 耐久状态留在 WebView 的 IndexedDB

access token、同步游标、本地时间线、草稿、重试队列，以及写进这台设备时复制的附件，由共用的 TypeScript 通信层写进 WebView 的 IndexedDB。不另建 SQLite，不进系统钥匙串。写进这台设备成功之后，才是未确认。

## Considered Options

- 用 Tauri SQL 插件另写应用私有 SQLite。否决：IndexedDB 已经能在重启后还在。再开一个库，只是把这些字节搬进 Rust。
- token 放进系统钥匙串。否决：V1 的边界是这台设备本身。清掉应用数据之后，钥匙串里还会留一个能发消息的 token。

## Consequences

- 清应用数据等于这台设备重新连接。本地时间线、草稿和重试队列一起没了。
- 按房间 ID 保存原始事件。通信层仍不认识 Topic，也不把 `m.replace` 收成气泡。
- V1 不淘汰本地时间线。媒体不进这个库。
- 断线用已有的同步游标再拉；只有服务器不认时才丢掉它。`M_UNKNOWN_TOKEN` 停同步并暂停重试队列，不把库清掉。
- 替 Owner 发出的 reaction 没成功时，按钮会恢复可点，但这一次仍留在重试队列里。人又点了另一档，才替换它。
- 已读标记写失败不能把已经采纳的更靠前位置打回去。队列里每条 Topic 只留当前最靠前的那条。
