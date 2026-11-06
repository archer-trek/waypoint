# 删除 Topic 不会忘掉 Agent

V1 结束一条 Topic 的方式是删除，不是归档。删除把它从 Waypoint 的所有设备上移除，且不能恢复。人设、记忆、工具和工作目录属于 Agent，删除 Topic 碰不到它们。归档能用 account data 做出来，但 V1 不需要可恢复的结束态。

## Considered Options

- 只做归档，不做删除。否决：可恢复不是要的结束语义。
- 删除即让 Agent 遗忘这段交流。做不到：记忆不在 Topic 上。
