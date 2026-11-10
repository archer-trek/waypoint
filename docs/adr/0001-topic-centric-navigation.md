# Topic 是主导航，Agent 在新建 Topic 时绑定

Waypoint 的日常入口是 Topic 列表，不是 Agent 通讯录。多个 Agent 仍在领域模型里：人设、记忆、工具和工作目录只能靠不同的 Hermes Profile（不同 Matrix 用户）隔开，同一个用户下多开房间做不到。Agent 在新建 Topic 时绑定，之后不能换；只配置了一个 Agent 时不出现选择。打到同一个 Agent 的 Topic 共享该 Agent 的身份与记忆，只隔开各自的交流记录。

## Considered Options

- 只做单 Agent，把多实例当成部署细节。否决：需要独立记忆或工作目录的用法就无法被表达。
- 以 Agent 通讯录为主导航，点进某个 Agent 再看它的 Topic。否决：日常高频操作是话题，不是找 Bot。

## Consequences

- Agent 不由 Topic 组成。某个 Agent 名下没有 Topic 时，它仍然可以被绑定。
- 协议映射要按「一个 Topic 绑定一个 Matrix 用户」来做，不能把多 Agent 收成一个房间里的线程。
