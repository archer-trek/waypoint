# Android 原生外壳桥接、媒体打开、网络安全策略与自动填充边界

为补齐 Android 端在系统返回退栈、媒体附件打开、状态栏对比度联动、冷启动底色、网络安全与自动填充方面的缺口，本决策确立 Android 原生外壳的跨层边界：全部原生扩展收敛于 [MainActivity.kt](../../src-tauri/gen/android/app/src/main/java/app/waypoint/client/MainActivity.kt) 与原生资源配置（不修改 `generated/` 下自动生成的 Tauri 包装代码）；媒体打开走应用私有缓存目录与 `FileProvider`；`release` 构建严格限制明文 HTTP（仅放行 `localhost` / `127.0.0.1`）；登录与重认证继续保留 WebView 内 HTML 表单与 `http://tauri.localhost` Origin，以保护已安装设备上 IndexedDB 中的「本地时间线」、凭证与「草稿」不因 Origin 变更而失效。

## Considered Options

- **在 `release` 包中允许任意明文 HTTP，或尝试在 `network_security_config.xml` 按内网/Tailscale 网段（如 `100.64.0.0/10`）放行**：否决。Android `network_security_config.xml` 的 `<domain>` 仅支持域名与单个静态 IP，不支持 CIDR 网段；而在正式包全局放行明文流量会降低传输安全性。因此选择 `debug` 允许明文 HTTP、`release` 严格禁止明文流量并仅放行 `localhost` / `127.0.0.1`，正式包连接 Tailscale 或内网自建「Homeserver 地址」统一走 HTTPS。
- **为解决 Bitwarden 在 WebView 中识别到 `http://tauri.localhost` 的问题，改用 Android 原生 `EditText` 账密输入弹窗，或本地 patch `tauri`/`wry` 切换为自定义 HTTPS Origin（`androidHostname` + `assetlinks.json`）**：否决。Tauri `2.12` 将 Android 本地前端写死在 `http://tauri.localhost/`，若更改 WebView Origin 会直接隔离并丢失已登录设备现有的 IndexedDB 数据，且需要维护未合并的上游 patch 与额外的公网 `assetlinks.json` 域名依赖；而额外维护一套原生登录 UI 会破坏双端共用界面（ADR-0003）的一致性。V1 选择保持 `http://tauri.localhost` Origin 与 WebView 登录不变，清理 `strings.xml` 字面引号并补齐登录/重认证表单的 `autoComplete` 语义。
- **媒体附件打开时申请外部存储权限写入公共下载目录，或在应用内自建图片/PDF 预览页**：否决。违反 ADR-0003 的共享薄壳原则，也引入不必要的系统权限弹窗；采用应用私有 `cacheDir` 配合 `FileProvider`（`content://` URI + `FLAG_GRANT_READ_URI_PERMISSION`）拉起 `Intent.ACTION_VIEW` 即可满足安全跨应用查看。
- **直接修改 `generated/TauriActivity.kt` 的 `handleBackNavigation`**：否决。`generated/` 属于 Tauri Android 自动生成目录，易被重新生成覆盖；统一在 `MainActivity` 中注册系统返回回调并与前端 `onSystemBack` / `popstate` 深度栈协同。

## Consequences

- **系统返回与导航退栈（对齐 ADR-0028）**：
  - `MainActivity` 接管系统返回手势与物理返回键并联动前端 `onSystemBack`：处在 Topic、表单、设置、模态确认框或存在未保存修改时由应用内退栈或拦截确认；处在最顶层 Topic 列表或认证入口且无弹窗时交还系统退出，不做“再按一次退出”拦截。
- **媒体附件打开（`open_media_file`）**：
  - Android 端临时媒体写入应用私有缓存目录（并在启动或写入前清理过期临时文件），通过 `FileProvider` 暴露为 `content://` URI 并附带精确 MIME 类型与只读授权拉起系统查看器，不申请外部存储权限。
- **网络安全边界**（分期于 `#140` 落地）：
  - `debug` 构建允许明文 HTTP 以便本地联调；`release` 构建通过 `network_security_config.xml` 全局禁用明文流量，仅放行 `localhost` / `127.0.0.1`。Owner 在正式包直连自建「Homeserver 地址」需使用 `https://`。（本项在 `#139` 期间暂维持既有 `usesCleartextTraffic = "false"`，于 `#140` 统一切换。）
- **自动填充与外观外壳**：
  - `strings.xml` 保持无外层引号的 `Waypoint`；登录与重认证输入框显式声明 `username` / `current-password` 等 `autoComplete` 语义（`Homeserver 地址` 隔离为 `url`）；Bitwarden 在 WebView 场景下仍将匹配 `http://tauri.localhost`。
  - 前端外观切换（`跟随系统` / `浅色` / `深色`）同步桥接至 `MainActivity` 的 `WindowInsetsControllerCompat`，保持状态栏与手势导航栏图标对比度正确；冷启动 `windowBackground` 锁定为 `#ffffff` / `#09090b`，并移除未使用的 `Hello World` 布局、示例配色与 Android TV `leanback` 声明。
- **Release 优化与 CI 门禁**（分期于 `#140` 落地）：
  - Android `release` 构建开启 R8 代码压缩（`isMinifyEnabled = true`）并配置 Tauri/Wry/插件 keep 规则；CI 针对 `src-tauri/**`、工作流配置变更及手动触发运行 Rust 与 Android 编译校验。（本项在 `#139` 期间暂维持 `isMinifyEnabled = false`，于 `#140` 启用。）
