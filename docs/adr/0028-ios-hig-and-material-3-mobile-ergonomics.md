# 吸收现代 iOS HIG 与 Android M3 移动端人机工效，保持单色独立外壳与去触觉反馈纯视觉交互

Waypoint 在多端设备矩阵扩展为 macOS、Windows、iOS 与 Android 的背景下，系统性对标现代 iOS Human Interface Guidelines 与 Android Material 3 规范。应用坚决捍卫 ADR-0026 的 Grokbot Monochrome 高对比黑白灰冷冽质感，拒绝平台拟物换皮与 Material You 动态色彩壁纸提取，但在移动端单栏栈式导航（窄视口）全面吸收两端核心物理人机工效：顶栏与行内小按钮遵循 iOS 14+ UIMenu 与 M3 TopAppBar 规范采用就地下拉菜单（Pull-down Menu）以杜绝长距离手指折返、长按消息采用带拖拽手柄与下滑退出的底部动作面板（Action Sheet）、补齐 24px 左边缘滑动返回手势（Edge Swipe Back）与代码块滚动冲突隔离、实现沉浸式顶栏滚动感知层级（Scroll-Aware Elevation）、为消息文档流引入长按上下文操作、落实表单脏数据防丢拦截，并明确否决移动端震动触觉反馈（保持纯视觉状态变更）。

## Considered Options

- **视觉层面分别拟态 iOS Cupertino 与 Android Material You**：否决。在 Android 随壁纸提取动态色彩、在 iOS 堆砌高饱和毛玻璃和拟物圆角会彻底瓦解 Waypoint 严肃、专业的工程工具心智。跨端追求的是底层的“操作工效与手感（Ergonomics）”，而非“外皮的色彩拟态”。
- **顶栏右上角操作与行内小按钮使用底部 Action Sheet**：否决。实际人机工效测试与 Owner 反馈表明，点击顶栏右上角 `···` 按钮后，若菜单在屏幕底部弹出，会导致手指跨越整屏进行 600~800px 的大幅“折返跑”，反使操作路径更长；这与 iOS 14+ 引入 `UIMenu` 替代导航栏 ActionSheet 以及 Material 3 Top AppBar Overflow Menu 的演进逻辑完全一致。因此，带具体小按钮锚点的操作统一确立为紧贴按钮就地展开的下拉气泡菜单（Pull-down Menu），位移零折返；底部 Action Sheet 仅服务于无独立小按钮锚点的大热区手势操作（如长按整条消息）。
- **引入触觉震动反馈（Haptics）**：否决。经权衡，保持纯视觉状态与缩放微动效（`active:scale-[0.99]`），避免在跨平台 Web/Tauri 容器中引入震动 API 权限请求与设备震动马达调校不一的割裂体验。
- **全屏任意区域左滑触发返回**：否决。Waypoint 时间线渲染大量长代码块（`<pre><code>`）与宽数据表格（`<table>`），若全屏捕获水平滑动，将导致横向滚动查阅代码时被频繁误打断并意外退栈。返回手势必须严格限制在屏幕左边缘 24px 判定区内，并在内容未抵左侧时让渡手势。

## Consequences

- **统一单色独立外壳（Opinionated Monochrome Shell）**：
  - 视觉样式、排版与语义色彩继续严格遵循 ADR-0026，仅在 Agent 阅读区保留 ADR-0027 的 Callout 彩色例外；双端界面不向 Material You 动态色盘妥协。
- **就地下拉菜单与底部面板的清晰分流（Pull-down Menu vs Action Sheet）**：
  - **顶栏 `···` 话题操作与失败消息行内操作**：统一采用紧贴触发按钮就地展开的下拉气泡菜单（`DropdownMenu` / iOS 14+ UIMenu 范式），项高 44px 舒适热区，手指零距离点选，杜绝从顶到底的折返疲劳；
  - **长按消息上下文操作**：长按整条消息（无独立小按钮锚点）时，呼出符合 iOS / M3 标准的底部动作面板（`ActionSheet`），带 36px 拖拽把手与手势下滑退出。
- **边缘滑动返回与栈导航手势（Edge Swipe Back）**：
  - 移动单栏栈式推入页（Topic 对话、新建/编辑 Topic、设置）全量支持屏幕左边缘滑动返回交互手势，附带水平平移视差过渡；
  - 手势捕获严格限制在屏幕左侧 24px 判定区（Edge Zone），并与时间线内横向滚动的代码块/表格互斥，代码块横滑时优先响应横向滚动；
  - 挂接 Android 系统返回手势与硬件返回键监听，退栈至 Topic 列表而非退出应用。
- **沉浸式顶栏滚动感知层级（Scroll-Aware Elevation）**：
  - `TopicHeaderView` 在移动端实现动态层级：时间线位于顶端（`scrollTop <= 4px`）时，底部分割线完全透明，与背景融为一体；时间线发生有效滚动（`scrollTop > 4px`）时，平滑渐显发丝分割线与毛玻璃背景。
- **表单脏数据防丢拦截（Unsaved Changes Guard）**：
  - 新建/编辑 Topic 与 Bot 登记表单检测输入修改；当存在未提交内容时，任何返回触发（手势滑动、顶栏箭头或 Android 系统返回）均唤起居中 `AlertDialog` 提示“放弃未保存的更改吗？”，防止误触丢失输入。
- **长按消息上下文操作（Long-press Context Menu）**：
  - 移动端消息（无框 Agent 文档流与 Owner 气泡）支持长按 500ms 呼出轻量上下文菜单，提供“复制纯文本”、“复制 Markdown”以及针对代码块的“复制代码”纯净操作。
- **全站浮层滚动条规范（Scroll-Only Overlay Scrollbars）**：
  - 弃用全局强制常驻的 6px 滚动条背景色，全站滚动容器（Detail 详情页时间线、Topic 列表、弹窗与代码块）统一重构为默认完全隐形（`scrollbar-color: transparent transparent`）；
  - 仅在用户产生滚动交互或悬停于滚动边缘时，发丝滑块平滑淡入浮现（`transition: background-color 0.2s`），停止操作后自动隐形，杜绝画布静态噪点；
  - Detail 详情页时间线的空间方位感知由现有的“回到底部”悬浮按钮（FAB）协同承接。
