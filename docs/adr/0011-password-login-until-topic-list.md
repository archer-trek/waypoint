# 首次连接只做密码登录，进列表才算已连接

Waypoint 的首次连接只接受 Homeserver 的 `https://` base URL 和密码登录。不粘贴 Access Token，不做发现，不申请 refresh token。名册为空时必须先登记一个 Agent。进入 Topic 列表才算已连接。

## Considered Options

- 允许粘贴 Access Token 或走 SSO。否决：Owner 不应先靠另一个客户端取出 token。交互式验证也不在 V1。
- 用 `.well-known` 发现，或跟随重定向。否决：自建的 client API 经常不在 server name 那台机器上。悄悄换地址，自检就对不上刚才那一台。
- 同步没完成也进空列表，或登记成功就自动建第一条 Topic。否决：空名册不能新建 Topic。首次连接的终点是能建，不是已经有一条。

## Consequences

- 登录成功就把 token 写入这台设备的 IndexedDB。密码不保存。还没进列表就可以放弃。进列表之后怎么退出，以及服务器不认 token 时怎么再登录，不在本决定里。
- 不请求 profile 来判断 Agent 是否存在。不把 Owner 自己登记进去。
- 登记写入前再读名册。已经有合法 Agent 就不再写入。
- 清掉应用数据等于这台设备重新走首次连接。这与 IndexedDB 的边界一致。
