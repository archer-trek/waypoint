# 渲染只认 body

Waypoint 渲染一条 Topic 里的文字时只读 `body`。若是 `m.replace`，读 `m.new_content.body`。不读 `formatted_body`，也不把它注入 WebView。编辑就地更新同一条气泡，并去掉末尾光标。没有续片关系的分片不合并。

## Considered Options

- 渲染 `formatted_body`。否决：消息不能在带 Tauri 命令的 WebView 里当 HTML 执行。公式是消毒之后才插回去的 `data-mx-maths`，编辑回退还会把 `* ` 直接拼在 HTML 前面。
- 把 `formatted_body` 当 body 缺失时的回退。否决：Hermes 总会写 body。回退会留下第二条渲染路径。
- 按时间把同一个 Agent 的连续文字粘成一条气泡。否决：协议没有续片关系。粘连会把两条普通消息合成一条，包括 Hermes 的进度文字和随后的回答。

## Consequences

- 表格或代码若被字节边界切开，就显示成两段。
- 成对的 `$...$` 和 `$$...$$` 交给 math 插件。不成对的美元保持原文。渲染失败就显示源码。
- 流式默认关闭。Waypoint 不要求 Owner 打开它。打开之后也只是同一条气泡的就地更新。
- 外链用系统浏览器。`http(s)` 不内联。要 token 的媒体只走通信层。
- mermaid 围栏当代码块。不重开。
