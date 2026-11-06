# Hermes Matrix 适配器：事件协议、会话隔离与多实例边界

调研对象：`NousResearch/hermes-agent` `main` @ `90d6b98fd86d20981ee06ddd5b7d93e4320f26a4`。
用途：为 [Waypoint V1 架构与产品决策地图](https://github.com/archer-trek/waypoint/issues/2) 的协议映射与会话交互决策提供一手事实。术语 `Owner`、`Agent` 按本仓库 `GLOSSARY.md`。

## 1. 出站消息、流式编辑与长文分片

Hermes 的 Matrix 适配器通过 `mautrix` 发送标准 `m.room.message`。普通文本回复走 `MatrixAdapter.send()`：先按 UTF-8 字节切块，再对每一块调用 `_build_text_message_content()`，最后 `send_message_event`。块与块之间**没有** `m.relates_to` 把它们标成同一条回复的续片；`send()` 只把**最后一块**的 `event_id` 返回给上层。

来源：[`plugins/platforms/matrix/adapter.py` `send()`](https://github.com/NousResearch/hermes-agent/blob/90d6b98fd86d20981ee06ddd5b7d93e4320f26a4/plugins/platforms/matrix/adapter.py#L1385-L1409)。

### 1.1 `body` 与 `formatted_body`

`_build_text_message_content()` 始终写入：

- `msgtype`: `m.text`
- `body`: 原始 Markdown（图片 Markdown 会被 `format_message()` 换成裸 URL）
- 当 HTML 转换结果与原文不同时，再加 `format: org.matrix.custom.html` 与 `formatted_body`

HTML 由 Python `markdown` 库生成，扩展为 `fenced_code`、`tables`、`nl2br`、`sane_lists`。库缺失时走正则回退。转换前会剥掉 `<script>` / `<style>` 和 `javascript:` / `data:` / `vbscript:` 链接。

来源：[`_build_text_message_content`](https://github.com/NousResearch/hermes-agent/blob/90d6b98fd86d20981ee06ddd5b7d93e4320f26a4/plugins/platforms/matrix/adapter.py#L2882-L2897)、[`_markdown_to_html`](https://github.com/NousResearch/hermes-agent/blob/90d6b98fd86d20981ee06ddd5b7d93e4320f26a4/plugins/platforms/matrix/adapter.py#L3017-L3031)。

允许进入 `formatted_body` 的标签白名单是：`a b blockquote br code del em h1–h6 hr i li ol p pre s strike strong table tbody td th thead tr ul`。`span`、`div`、`img`、`details` 不在白名单里。`code` 只保留 `class="language-..."`。

来源：[`_MatrixHtmlSanitizer`](https://github.com/NousResearch/hermes-agent/blob/90d6b98fd86d20981ee06ddd5b7d93e4320f26a4/plugins/platforms/matrix/adapter.py#L262-L295)。

Matrix 规范建议的 HTML 子集**包含** `table` / `thead` / `tbody` / `tr` / `th` / `td`，也包含 `span` / `div` / `details`。Hermes 的表被放进了规范允许的标签，但公式用的 `span`/`div` 是在消毒**之后**再插回去的。

来源：[Client-Server API, `org.matrix.custom.html`](https://spec.matrix.org/latest/client-server-api/)。

### 1.2 公式

`$...$` / `$$...$$` 先换成哨兵，HTML 消毒后再展开成：

```html
<span data-mx-maths="...">...</span>
<div data-mx-maths="...">...</div>
```

不成对的美元（如 `$5 or $10`）保持字面量。`body` 仍是原始 TeX。这是 Element Labs「Render LaTeX maths」的标记，不是通用 Markdown。

来源：[`_latex_to_tokens` / `_tokens_to_mx_maths`](https://github.com/NousResearch/hermes-agent/blob/90d6b98fd86d20981ee06ddd5b7d93e4320f26a4/plugins/platforms/matrix/adapter.py#L649-L686)，以及[官方 Matrix 文档](https://github.com/NousResearch/hermes-agent/blob/90d6b98fd86d20981ee06ddd5b7d93e4320f26a4/website/docs/user-guide/messaging/matrix.md)。

### 1.3 分片上限

Homeserver 拒绝 JSON 超过 65536 字节的事件（`M_TOO_LARGE`）。适配器把事件内容预算卡在 45000 字节。因为同一段文本会以 `body` + `formatted_body` 出现两次，而 HTML 大约能胀到 Markdown 的两倍，所以单块上限是 `45000 // 3 = 15000` UTF-8 字节。配置项 `MATRIX_MAX_MESSAGE_LENGTH` 会被夹在 500 与 15000 之间。旧的 4000 字符默认值会把 GFM 表格从行中间切开，这是改成按字节、并抬高上限的原因。

来源：[`_MAX_CONTENT_BYTES` / `MATRIX_MAX_MESSAGE_LENGTH_CEILING`](https://github.com/NousResearch/hermes-agent/blob/90d6b98fd86d20981ee06ddd5b7d93e4320f26a4/plugins/platforms/matrix/adapter.py#L376-L408)。

客户端识别「同一轮回复的多块」时，协议层没有续片关系。可靠特征只有：同一发送者、同一房间（以及若开了线程，则同一 `m.thread` 根）、时间上连续、且只有最后一块的 id 被上层记成这条回复的 `message_id`。

### 1.4 流式编辑

网关流式默认关闭（`streaming.enabled: false`）。打开后，`transport: auto` 在 Matrix 上走编辑而不是 draft。默认编辑间隔 **0.8 秒**，缓冲阈值 24 字符，进行中的预览会附上光标 ` ▉`。

来源：[ `hermes_cli/config_defaults.py` 的 `streaming` 段](https://github.com/NousResearch/hermes-agent/blob/90d6b98fd86d20981ee06ddd5b7d93e4320f26a4/hermes_cli/config_defaults.py)。

Matrix 侧 `edit_message()` 发送一条新的 `m.room.message`，而不是改原事件：

```text
body: "* " + 当前全文          # 不支持编辑的客户端看到的回退
formatted_body: "* " + HTML    # 同样加了星号前缀
m.new_content: 完整的新内容（不再加星号）
m.relates_to: { rel_type: "m.replace", event_id: <被编辑事件> }
```

内容超过 45000 字节时，顶层 `formatted_body` 会被丢掉，顶层 `body` 被截短；`m.new_content` 保留完整内容。适配器**入站忽略** `rel_type == m.replace`，所以 Agent 不会把编辑事件当成新的用户消息。

来源：[`edit_message`](https://github.com/NousResearch/hermes-agent/blob/90d6b98fd86d20981ee06ddd5b7d93e4320f26a4/plugins/platforms/matrix/adapter.py#L1475-L1499)、[`_on_room_message` 跳过编辑](https://github.com/NousResearch/hermes-agent/blob/90d6b98fd86d20981ee06ddd5b7d93e4320f26a4/plugins/platforms/matrix/adapter.py#L2058-L2060)。

### 1.5 FluffyChat / Cinny 渲染翻车的协议层原因

已核实、可直接解释用户看到的 Markdown 问题：

1. **FluffyChat 把表格当纯文本。** 官方 issue [#2918](https://github.com/krille-chan/fluffychat/issues/2918) 写明：Markdown 表格显示成原始文本，因为所用 `flutter_markdown` 的表格支持很弱。Hermes 的 `body` 就是这份原始 Markdown；若客户端优先渲染 `body` 而不是 `formatted_body` 里的 `<table>`，表格必然碎。
2. **双载荷不一致。** 支持编辑的客户端应渲染 `m.new_content`；不支持的客户端会把 `* ` 前缀的回退 `body` / `formatted_body` 当成新消息。`formatted_body` 的星号是直接拼在 HTML 前面的，不是包在文本节点里，HTML 客户端可能把这段当成坏标记。
3. **公式标记不是通用 Markdown。** `data-mx-maths` 是 Element 实验室功能。FluffyChat / Cinny 不实现它时，用户看到的是 span/div 里的转义 TeX，或 `body` 里的 `$...$`。
4. **长回复是多条独立事件。** 代码围栏或表格一旦跨过 15000 字节边界，后半段没有「续片」关系。通用 IM 时间线会把它画成多条气泡。
5. **Cinny 没有在本次检索里找到与 FluffyChat #2918 同级的「表格不渲染」issue。** 能确认的是 Cinny 会消费 `formatted_body`（例如 [#2310](https://github.com/cinnyapp/cinny/issues/2310) 讨论内联 `<img>`）。因此 Cinny 上的翻车更可能来自 HTML 子集、编辑回退星号、公式标记和分片，而不是「完全不解析 Markdown」。这一点不要写成已复现的 Cinny bug。

## 2. 思考流与工具活动

Matrix **没有**单独的 thinking/tool 事件类型。官方文档说的「threaded, editable thinking/tool-activity panes」是网关进度气泡，不是自定义 Matrix 类型。

来源：[Matrix 文档「Thinking and tool activity」](https://github.com/NousResearch/hermes-agent/blob/90d6b98fd86d20981ee06ddd5b7d93e4320f26a4/website/docs/user-guide/messaging/matrix.md)。

机制：

- `display.tool_progress` 打开后，`tool.started` 被渲染成一行 Markdown（emoji + 动词 + 预览；`terminal` 会放进围栏代码块）。`tool.completed` **不**进这行气泡。
- `_thinking` 只有在该平台显式打开 `thinking_progress` 时才入队。Mattermost 被点名必须显式覆盖；Matrix 没有被单独排除。
- 因为 `MatrixAdapter.edit_message` 不是基类空实现，进度发送器会维护**一个可编辑气泡**：第一条 `send()`，之后每 **1.5 秒**最多 `edit_message()` 一次。超长则再开一个新气泡，只继续编辑最新那条。
- 气泡的线程关系来自 `metadata.thread_id`。房间默认 `MATRIX_AUTO_THREAD=true` 时，触发消息的 `event_id` 会被当成合成线程根，进度和回复都挂在这个 `m.thread` 上，所以不刷主时间线。DM（≤2 人）默认**不**自动建线程，进度落在房间主时间线，除非开了 `MATRIX_DM_AUTO_THREAD` 或消息本身已在线程里。
- 回合结束若 `cleanup_progress` 打开，这些气泡的 `event_id` 会被记下来供清理。Matrix 适配器本身没有 `send_or_update_status`，普通 status 回调退回成新的 `send()`。

来源：[`send_progress_messages`](https://github.com/NousResearch/hermes-agent/blob/90d6b98fd86d20981ee06ddd5b7d93e4320f26a4/gateway/run_turn_progress.py#L741-L758)、[`_progress_send_or_edit`](https://github.com/NousResearch/hermes-agent/blob/90d6b98fd86d20981ee06ddd5b7d93e4320f26a4/gateway/run_turn_progress.py#L716-L739)、[`_resolve_progress_thread_id`](https://github.com/NousResearch/hermes-agent/blob/90d6b98fd86d20981ee06ddd5b7d93e4320f26a4/gateway/run.py#L818-L837)。

对 Waypoint 的含义：思考/工具流不是一种稳定的结构化事件。它是普通 Markdown 消息 + `m.replace`。自有客户端若只靠通用时间线，会看到一条不断被编辑的状态气泡，以及可能被 redaction 清掉的表情。

## 3. 表情、审批、选择器与斜杠命令

### 3.1 处理中表情

`MATRIX_REACTIONS` 默认 true。

- 开始处理：对用户消息发 `👀`（U+1F440），记下 reaction 的 `event_id`。
- 完成：延迟 **5 秒** redaction 掉 `👀`，再发 `✅`（成功）或 `❌`（失败，U+274C）。取消（`CANCELLED`）则什么都不做。
- 表情事件类型是 `m.reaction`，内容为 `m.relates_to: { rel_type: "m.annotation", event_id, key }`。

来源：[`on_processing_start` / `on_processing_complete`](https://github.com/NousResearch/hermes-agent/blob/90d6b98fd86d20981ee06ddd5b7d93e4320f26a4/plugins/platforms/matrix/adapter.py#L2477-L2491)、[`_send_reaction`](https://github.com/NousResearch/hermes-agent/blob/90d6b98fd86d20981ee06ddd5b7d93e4320f26a4/plugins/platforms/matrix/adapter.py#L2444-L2455)。

### 3.2 危险命令审批

适配器发一条 Markdown 提示，再由 bot 自己种下可选表情。用户点这些表情即选择。映射是固定的：

| 选择 | 表情 |
| --- | --- |
| once | ✅ |
| session | 🌀 |
| always | ♾️ |
| deny | ❌ |

同一 session 只保留最新一条审批提示。默认 `MATRIX_APPROVAL_REQUIRE_SENDER=true`，只有发起者的 reaction 有效。超时默认 300 秒。入站 reaction 若来自 bot 自己会被忽略。

来源：[`_EA_REACTIONS` / `_send_exec_approval_prompt`](https://github.com/NousResearch/hermes-agent/blob/90d6b98fd86d20981ee06ddd5b7d93e4320f26a4/plugins/platforms/matrix/adapter.py#L1671-L1703)、模块头注释中的超时与 sender 限制。

### 3.3 `/model` 与通用选择器

`/model` 用 keycap `1️⃣`–`9️⃣` 加 `🔟`。`/reasoning`、`/fast` 一类选择器在此基础上再加 `🅰️` `🅱️`。选择器是普通文本加 bot 预种的 reaction，不是自定义事件。

来源：[`_MATRIX_MODEL_PICKER_REACTIONS`](https://github.com/NousResearch/hermes-agent/blob/90d6b98fd86d20981ee06ddd5b7d93e4320f26a4/plugins/platforms/matrix/adapter.py#L427-L429)、[`send_model_picker`](https://github.com/NousResearch/hermes-agent/blob/90d6b98fd86d20981ee06ddd5b7d93e4320f26a4/plugins/platforms/matrix/adapter.py#L1705-L1736)。

### 3.4 斜杠命令

许多 Matrix 客户端把 `/` 留给本地命令。适配器因此把已知的 `!command` 规范成 `/command` 再交给网关；未知的 `!` 保持普通文本。官方文档点名的行为包括 `/status`、`/resume`、`/resume --cross-room`、`/model`、`/set-home`。`/new` 属于网关通用会话命令，不是 Matrix 专用事件。

来源：[`_normalize_matrix_bang_command`](https://github.com/NousResearch/hermes-agent/blob/90d6b98fd86d20981ee06ddd5b7d93e4320f26a4/plugins/platforms/matrix/adapter.py#L134-L168)，[Matrix 文档 Commands / Project Room Isolation](https://github.com/NousResearch/hermes-agent/blob/90d6b98fd86d20981ee06ddd5b7d93e4320f26a4/website/docs/user-guide/messaging/matrix.md)。

## 4. 会话隔离：单 Profile 与多实例

### 4.1 DM 判定与线程

加入人数 ≤ 2 的房间一律视为 DM，不管 `m.direct` 或房间名。DM 免 `@mention`，绕过 `MATRIX_ALLOWED_ROOMS` / `MATRIX_REQUIRE_MENTION` / `MATRIX_FREE_RESPONSE_ROOMS`，并改用 `MATRIX_DM_AUTO_THREAD`（默认 false）而不是 `MATRIX_AUTO_THREAD`（默认 true）。受邀自动加入；若邀请带 `is_direct`，会写入 `m.direct` account data。

来源：适配器模块文档字符串，以及 [`_resolve_room_identity`](https://github.com/NousResearch/hermes-agent/blob/90d6b98fd86d20981ee06ddd5b7d93e4320f26a4/plugins/platforms/matrix/adapter.py#L2805-L2836)。

`MATRIX_SESSION_SCOPE`：

| 值 | 行为 |
| --- | --- |
| `auto` | 沿用 `MATRIX_AUTO_THREAD`。房间里未在线程中的消息会把触发事件 id 当成合成线程根。 |
| `room` | 未线程化的房间消息停在稳定的房间会话。真实 MSC3440 线程仍用线程根。 |
| `thread` | 未线程化的房间消息也从触发事件 id 合成线程/会话。 |

DM 不走这张表，走 DM 专用开关。真实 `m.thread` 根优先于合成根。

来源：[`_resolve_message_context`](https://github.com/NousResearch/hermes-agent/blob/90d6b98fd86d20981ee06ddd5b7d93e4320f26a4/plugins/platforms/matrix/adapter.py#L2116-L2125)，[官方文档 Session Model](https://github.com/NousResearch/hermes-agent/blob/90d6b98fd86d20981ee06ddd5b7d93e4320f26a4/website/docs/user-guide/messaging/matrix.md)。

房间名、topic、room id 会放进 `SessionSource`（`chat_name` / `chat_topic`）。官方文档说这些加上一条 room-boundary 说明会进入 Agent 提示词。`/resume` 默认不跨房间恢复命名会话。

### 4.2 一个 Profile 里多个房间隔离什么

同一个 Hermes Profile（同一个 home、同一个 Matrix bot 账号）下：

- **能隔离**：会话转录。每个 DM 一个 session；每个线程一个 session namespace；共享房间里默认按用户再拆（`group_sessions_per_user: true`）。`/model` 改的是会话模型，不是 Profile 身份。
- **不能隔离**：`SOUL.md`、记忆、技能、工具集、`config.yaml`、`.env`、`terminal.cwd`、cron。房间名和 topic 只是提示词上下文，不是第二套人设。两个 2 人房间打到同一个 bot，背后是同一个 Agent 进程配置。

### 4.3 Profile 与多实例

Profile 是独立的 Hermes home：各自的 `config.yaml`、`.env`、`SOUL.md`、memories、sessions、skills、cron、`state.db`。两个进程不能指向同一个 Profile，否则记忆会互相写入。消息通道凭证默认不随 clone 复制，避免两个 gateway 抢同一个 bot token。

来源：[Profiles 文档](https://github.com/NousResearch/hermes-agent/blob/90d6b98fd86d20981ee06ddd5b7d93e4320f26a4/website/docs/user-guide/profiles.md)。

多 Profile 可以：

- 一机多进程（每 Profile 一个 gateway），或
- 默认开启的 multiplex：一个 gateway 进程服务多个 Profile，但重复的 bot 凭证会被拒绝。Matrix 适配器按活动 Profile 读 homeserver、token、device id 和 `crypto.db`，避免二级 Profile 用到默认 Profile 的身份。

来源：[Multi-profile gateways](https://github.com/NousResearch/hermes-agent/blob/90d6b98fd86d20981ee06ddd5b7d93e4320f26a4/website/docs/user-guide/multi-profile-gateways.md)，适配器 `__init__` 关于 multiplex 作用域的注释。

因此：Waypoint 若需要不同人设、记忆、工具或工作目录，必须绑定**不同的 Matrix bot 账号**（不同 Profile 或不同部署）。同一 bot 下多房间只能隔离会话转录和提示词里的房间名/topic，不能隔离 Agent 身份。

## 对后续决策单的直接含义

- 自有客户端应把 `body` 的 Markdown 当主数据，把 `formatted_body` 当兼容回退。表格、代码语言类和公式在 `body` 里信息更全；`formatted_body` 的表是规范内 HTML，但公式和编辑星号不可靠。
- 长回复要按「同一发送者、同一线程根、连续事件」合并，不能等协议层的续片 id。
- 思考/工具/审批都是普通消息 + `m.replace` / `m.reaction` / redaction，不是自定义事件。Waypoint 可以在 UI 上收成面板，但同步层必须识别这些关系。
- 多 Agent 若要真实隔离，对应多个 Matrix 用户；多房间不够。
