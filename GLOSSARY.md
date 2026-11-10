# Waypoint

面向单人使用的一对一 Personal Agent 专属客户端。Owner 通过 Matrix 与一个或多个 Agent 一对一交流，不提供多人社交、群聊或空间管理。

## Language

**Owner**:
使用 Waypoint 的唯一人类本人，跨个人设备（macOS、Android）以同一身份与各 Agent 协作。
_Avoid_: Member, participant, admin, customer

**Agent**:
与 Owner 一对一交互的单个 AI 助理个体。一个人设、一套记忆、一套工具与一个工作目录都属于这一个 Agent；在 Matrix 上它是一个独立用户，背后是一个 Hermes Profile 或一套独立部署。面向 Owner 的界面文案称 Bot。Owner 登记之后它才进入 Waypoint；名下没有 Topic 时也还在。
_Avoid_: contact, friend, peer, instance

**名册**:
Owner 登记过的 Agent（面向 Owner 的界面文案称 Bot 名册）。空的时候不能新建 Topic。不是通讯录，也不是设备列表。
_Avoid_: 通讯录, contact list, roster

**已连接**:
这台设备已经进入 Topic 列表，并且还没退出。还停在同步或登记，不是已连接。
_Avoid_: 在线, online, 已登录

**Topic**:
Owner 与唯一一个 Agent 之间的一次有界交流。Owner 在新建它时写下名字；绑定的 Agent 也在新建时确定，之后不变。同一 Agent 下的多个 Topic 只隔开各自的交流记录，不隔开该 Agent 的人设、记忆、工具或工作目录。
_Avoid_: Session, 会话, Room, Chat, Thread, conversation

**Description**:
Owner 为一条 Topic 写下的可选上下文，给这条 Topic 所绑定的 Agent 看，不是私密备忘。留空表示没有额外上下文。
_Avoid_: topic, note, 备注, prompt, subtitle

**不可用**:
一条 Topic 还在列表里，但不能发消息，也不能换绑定的 Agent。可以改名、改 Description、置顶和删除。
_Avoid_: 异常, 错误房间, 禁用, locked

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
这台设备上一条 Topic 已经存下的内容，包括未确认的消息，以及还没丢掉的失败。只在这台设备上。不是会话。
_Avoid_: 历史, 缓存, transcript, 消息记录

**未确认**:
这台设备上一条已经写在本地、Homeserver 还没确认的消息。不是草稿。
_Avoid_: 发送中, 上传中, 重试中, pending

**失败**:
这台设备上一条已经被 Homeserver 永久拒绝、还没丢掉的消息。不是 Hermes 标在消息上的 ❌，也不是未读。新建 Topic、改名、改 Description、置顶、名册或删除没成功，不是失败。
_Avoid_: 错误, error, 发送失败

**重试队列**:
这台设备上的未确认消息，替 Owner 发出的 reaction，以及更靠前的已读位置。不是草稿。新建 Topic、改名、改 Description、置顶和名册不在里面。
_Avoid_: 乐观队列, outbox, 未发送消息, 缓存

**正在回应**:
Agent 在一条 Topic 里用 👀 标出的处理中状态。👀 还在，状态就在。
_Avoid_: typing, 思考中, 生成中, streaming

**Session**:
Hermes 当前用于一条 Topic 的那段交流记录，中文称为会话。换一段不会换 Topic，也不会换掉该 Agent 的人设、记忆、工具或工作目录。
_Avoid_: 转录, transcript, history, chat
