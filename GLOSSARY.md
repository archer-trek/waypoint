# Waypoint

面向单人使用的一对一 Personal Agent 专属客户端（以 Matrix 为底层传输协议接入一个或多个 Hermes 实例或 Profile，屏蔽多用户社交、群聊与空间管理心智）。

## Language

**Owner**:
使用 Waypoint 的唯一人类本人，跨个人设备（macOS、Android）以同一身份与各 Agent 协作。
_Avoid_: Member, participant, admin, customer

**Agent**:
与 Owner 一对一交互的单个 AI 助理个体。一个人设、一套记忆、一套工具与一个工作目录都属于这一个 Agent；在 Matrix 上它是一个独立用户，背后是一个 Hermes Profile 或一套独立部署。面向 Owner 的界面文案称 Bot。Owner 登记之后它才进入 Waypoint；名下没有 Topic 时也还在。
_Avoid_: contact, friend, peer, instance

**名册**:
Owner 登记过的 Agent（面向 Owner 的界面文案称 Bot 名册）。空的时候不能新建 Topic。不是通讯录。
_Avoid_: 通讯录, contact list, roster

**已连接**:
这台设备已经进入过 Topic 列表。还停在同步或登记，不是已连接。
_Avoid_: 在线, online, 已登录

**Topic**:
Owner 与唯一一个 Agent 之间的一次有界交流。Owner 在它诞生时写下名字；绑定的 Agent 也在诞生时确定，之后不变。同一 Agent 下的多个 Topic 只隔开各自的交流记录，不隔开该 Agent 的人设、记忆、工具或工作目录。
_Avoid_: Session, 会话, Room, Chat, Thread, conversation

**Description**:
Owner 为一条 Topic 写下的可选上下文，给这条 Topic 所绑定的 Agent 看，不是私密备忘。留空表示没有额外上下文。
_Avoid_: topic, note, 备注, prompt, subtitle

**已读位置**:
Owner 在一条 Topic 里读到的那条消息。一条 Topic 一份。不是滚动位置，也不是列表上的未读提示。Owner 的各台设备看到同一份。
_Avoid_: 未读角标, 滚动位置, receipt, fully read

**未读**:
一条 Topic 的列表状态：已读位置之后还有要渲染的新消息。未确认和失败不算。不是条数，也不是服务器的通知计数。
_Avoid_: 未读数, notification, 红点

**草稿**:
一条 Topic 里还没发出的输入，包括文字和已选未发的附件。只留在写下它的那台设备上。换一台设备不会出现。
_Avoid_: 队列, 缓存, 未发送消息

**同步游标**:
这台设备继续增量同步用的不透明位置。不是某条消息，也不是已读位置。
_Avoid_: since, next_batch, 检查点, checkpoint

**本地时间线**:
这台设备上一条 Topic 已存下的房间事件，包括未确认的交出，以及还没丢掉的失败。只在这台设备上。不是会话。
_Avoid_: 历史, 缓存, transcript, 消息记录

**未确认**:
这台设备上一条已经交出、Homeserver 还没确认的消息。不是草稿。上传、退避和暂停都不另算一种。
_Avoid_: 发送中, 上传中, 重试中, pending

**失败**:
这台设备上一条被永久拒绝、还没丢掉的交出。不是 Hermes 标在消息上的 ❌，也不是未读。
_Avoid_: 错误, error, 发送失败

**重试队列**:
这台设备上已经交出、还没被确认的工作。不是草稿。
_Avoid_: 乐观队列, outbox, 未发送消息, 缓存

**正在回应**:
Agent 在一条 Topic 里用 👀 标出的处理中状态。这个标记还在，状态就在。
_Avoid_: typing, 思考中, 生成中, streaming

**Session**:
Hermes 当前用于一条 Topic 的那段交流记录，中文称为会话。换一段不会换 Topic，也不会换掉该 Agent 的人设、记忆、工具或工作目录。
_Avoid_: 转录, transcript, history, chat
