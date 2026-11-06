# Matrix 客户端放在共用的 TypeScript 里

薄 Client-Server 客户端是共用 React 界面的一部分，不是 Rust 命令。只有它跟 Homeserver 说话。它向上交出原始事件，不认识 Topic，不把 `m.replace` 收成气泡。Rust 只保留剪贴板、拖文件、软键盘 inset 这类系统能力。

## Considered Options

- 把客户端放进 Rust，经 Tauri IPC 把每批 `/sync` 交给界面。否决：协议不是系统能力，JSON 会多序列化一次，也不是在给 E2EE 留门。

## Consequences

- 上层不自己拿 token 去请求 Homeserver。
- access token 和 `since` 由这层持有。落在哪里不在本决定里。
- 断网重试策略仍未指定。这层只保证能停、能用已有的 `since` 再拉。
