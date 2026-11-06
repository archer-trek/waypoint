# Waypoint

面向单人使用的一对一 Personal Agent 专属客户端（以 Matrix 为底层传输协议接入一个或多个 Hermes 实例或 Profile，屏蔽多用户社交、群聊与空间管理心智）。

## Language

**Owner**:
使用 Waypoint 的唯一人类本人，跨个人设备（macOS、Android）以同一身份与各 Agent 协作。
_Avoid_: Member, participant, admin, customer

**Agent**:
与 Owner 一对一交互的单个 AI 助理个体。一个人设、一套记忆、一套工具与一个工作目录都属于这一个 Agent；在 Matrix 上它是一个独立用户，背后是一个 Hermes Profile 或一套独立部署。
_Avoid_: Bot, contact, friend, peer, instance

**Topic**:
Owner 与唯一一个 Agent 之间的一次有界交流。Owner 在它诞生时写下名字；绑定的 Agent 也在诞生时确定，之后不变。同一 Agent 下的多个 Topic 只隔开各自的交流记录，不隔开该 Agent 的人设、记忆、工具或工作目录。
_Avoid_: Session, 会话, Room, Chat, Thread, conversation

**Description**:
Owner 为一条 Topic 写下的可选上下文，给这条 Topic 所绑定的 Agent 看，不是私密备忘。留空表示没有额外上下文。
_Avoid_: topic, note, 备注, prompt, subtitle
