# Matrix 层是薄 Client-Server 客户端

V1 不引入 `matrix-rust-sdk`、`matrix-js-sdk` 或 Dart `matrix`。通信层只覆盖非加密 Personal Agent 要用的 Client-Server 端点，对上层交出原始事件。它不认识 Topic，不渲染时间线，不实现 E2EE。

## Considered Options

- 完整 SDK 并关闭 E2EE。否决：加密栈和存储仍在，主要收益是以后补 E2EE，而 E2EE 不在范围内。

## Consequences

- 编辑、reaction、redact 和认证媒体要自己按规范发。
- 以后若把 E2EE 拉回范围，这层要重做，而不是打开一个开关。
