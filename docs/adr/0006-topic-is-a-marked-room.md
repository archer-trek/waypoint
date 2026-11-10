# 一条 Topic 是一个 Waypoint 标记的两人房间

一条 Topic 在 Matrix 上是 Waypoint 新建的一个两人、未加密房间，只邀请它绑定的那一个 Agent。名字写在房间名上，Description 写在 topic 上，Hermes 才会把它们放进提示词。Waypoint 用房间状态 `im.waypoint.topic` 认出自己的 Topic，不把 Homeserver 上已有的房间收进来。同一个 Agent 可以有多条 Topic。

## Considered Options

- 同一个 Agent 的多条 Topic 收成一个房间里的 MSC3440 线程。否决：名字和 Description 是房间级的，删不掉一条线程。
- 用 `/new` 和 `/resume` 当 Topic 边界。否决：那是网关命令，别的设备从同步里重建不出 Topic 列表。
- 把和已登记 Agent 的两人房间，或 `m.direct` 里的房间，都当成 Topic。否决：旧私聊和加密房间会混进来。`m.direct` 是一个用户对应多间房间的列表，不是 Topic 列表的来源。

## Consequences

- 删除是 leave 再 forget。不踢 Agent，也不让 Hermes 遗忘。Homeserver 上可以留痕迹。
- 置顶是 Owner 的 `m.tag` `im.waypoint.pinned`，不是收藏。排序看最新消息时间，不另存。
- Agent 名册在 Owner 的 account data 里，只收当前 Homeserver 的用户。移除名册不删除已有 Topic。
- 多于两人、邀请失败、新建后加密，或看不懂的标记，Topic 留在列表里但不可用。Waypoint 不踢人、不撤邀请、不解除 ban。
- 新建时就已经加密的房间立刻 leave 再 forget，不进列表。
- 标记写上之后 Waypoint 不改写。另一个客户端改了标记，绑定会跟着变；V1 不回滚。
- Hermes 的主动消息落在哪，不在本决定里。
