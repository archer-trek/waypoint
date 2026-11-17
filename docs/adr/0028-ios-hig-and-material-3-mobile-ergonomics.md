# 吸收现代 iOS HIG 与 Android M3 移动端人机工效，保持单色独立外壳与去触觉反馈纯视觉交互

Waypoint 在多端设备矩阵扩展为 macOS、Windows、iOS 与 Android 的背景下，系统性对标现代 iOS Human Interface Guidelines 与 Android Material 3 规范。应用坚决捍卫 ADR-0026 的 Grokbot Monochrome 高对比黑白灰冷冽质感，拒绝平台拟物换皮与 Material You 动态色彩壁纸提取，但在移动端单栏栈式导航（窄视口）全面吸收两端核心物理人机工效：将顶栏悬浮次级菜单重构为带拖拽手柄与手势下滑退出的底部动作面板（Action Sheet）、补齐 24px 左边缘滑动返回手势（Edge Swipe Back）与代码块滚动冲突隔离、实现沉浸式顶栏滚动感知层级（Scroll-Aware Elevation）、为消息文档流引入长按上下文操作、落实表单脏数据防丢拦截，并明确否决移动端震动触觉反馈（保持纯视觉状态变更）。

## Considered Options

- **视觉层面分别拟态 iOS Cupertino 与 Android Material You**：否决。在 Android 随壁纸提取动态色彩、在 iOS 堆砌高饱和毛玻璃和拟物圆角会彻底瓦解 Waypoint 严肃、专业的工程工具心智。跨端追求的是底层的“操作工效与手感（Ergonomics）”，而非“外皮的色彩拟态”。
- **移动端顶栏操作继续复用右上角悬浮气泡（DropdownMenu）**：否决。在大屏单手握持时，屏幕顶部是严重的拉伸费力区。在右上角狭窄气泡内操作高危的“删除 Topic”极易发生重心失衡或误触。底部动作面板（Action Sheet）将操作沉入自然拇指热区，是移动端的黄金标准。
- **引入触觉震动反馈（Haptics）**：否决。经权衡，保持纯视觉状态与缩放微动效（`active:scale-[0.99]`），避免在跨平台 Web/Tauri 容器中引入震动 API 权限请求与设备震动马达调校不一的割裂体验。
- **全屏任意区域左滑触发返回**：否决。Waypoint 时间线渲染大量长代码块（`<pre><code>`）与宽数据表格（`<table>`），若全屏捕获水平滑动，将导致横向滚动查阅代码时被频繁误打断并意外退栈。返回手势必须严格限制在屏幕左边缘 24px 判定区内，并在内容未抵左侧时让渡手势。

## Consequences

- **统一单色独立外壳（Opinionated Monochrome Shell）**：
  - 视觉样式、排版与语义色彩继续严格遵循 ADR-0026，仅在 Agent 阅读区保留 ADR-0027 的 Callout 彩色例外；双端界面不向 Material You 动态色盘妥协。
- **底部动作面板（Action Sheet / Bottom Sheet）**：
  - 窄视口（`isNarrow`）下，顶栏 `···` 话题操作与时间线失败消息操作由右上角悬浮气泡替换为底部升起的动作面板；
  - 面板顶部配备 36px 拖拽把手（Grabber），支持手指下拉平滑退出（Swipe-to-dismiss）；
  - 布局遵循严格人机工效层级：上层为常规操作（置顶、编辑），破坏性操作（“删除 Topic”）标为语义红字置底，最下方提供全宽独立“取消”按键；桌面宽视口维持现有 DropdownMenu。
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
