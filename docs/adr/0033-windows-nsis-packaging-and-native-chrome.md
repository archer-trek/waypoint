# Windows 打包采用 NSIS（currentUser）与原生 Win32 窗口外壳

Windows 端构建仅产出单一 NSIS 安装包（`.exe`，默认 `x86_64-pc-windows-msvc` / `x64`，脚本预留 `aarch64-pc-windows-msvc` / `arm64`），配置为 `installMode: "currentUser"`、`languages: ["SimpChinese", "English"]`（随系统语言自动匹配且不弹出语言选择框）、`webviewInstallMode: { type: "downloadBootstrapper", silent: true }`（不设 `minimumWebview2Version` 硬门槛），默认产出未签名安装包并预留 `WINDOWS_SIGN_COMMAND` / `WINDOWS_CERTIFICATE_THUMBPRINT` 签名钩子。运行时保持 Windows 原生 Win32 标题栏与关闭即退出语义，并在 `sync_system_appearance` 中同步原生窗口主题（`window.set_theme`），同时统一清理 Windows 非法与保留设备名附件文件名并按平台识别 `Waypoint Windows` 设备显示名；所有桌面端发布统一由 `.github/workflows/release.yml` 并行构建后原子汇总到同一份 Draft GitHub Release（后续在 [ADR-0038](./0038-unified-multi-platform-release-workflow.md) 中进一步将 Android 与两段式发版流程纳入该统一工作流）。

## Considered Options

- 同时提供 WiX (`.msi`) 与免安装便携 `.zip`。否决：扩大维护与发布校验矩阵；NSIS 单文件安装向导覆盖安装平滑且体积最小。
- 将 `nsis.installMode` 设为 `both` 或 `perMachine`。否决：在 Tauri/NSIS 中即便选 `both`，即使用户只选当前用户也会先触发 UAC 提权弹窗，且安装注册表路径（`HKCU` vs `HKLM`）切换成本高；个人单用户客户端优先无提权体验。
- 为 WebView2 内嵌 `offlineInstaller`（约 +127 MB）或设置 `minimumWebview2Version`。否决：Windows 11 已自带运行时，Windows 10 缺失时由静默 `downloadBootstrapper` 补装即可；与 [ADR-0003](./0003-tauri-shared-web-ui.md) 一致不对系统 WebView 设硬门槛。
- 跨平台自绘无边框标题栏或关闭时最小化到托盘。否决：Windows 与 macOS 窗口控制区交互习惯差异大，保持原生 Win32 标题栏并通过 `window.set_theme` 同步深浅色即可无缝融入桌面外观，避免过早引入托盘常驻生命周期复杂度。
- 保留独立的 `release-macos.yml` 并新增 `release-windows.yml` 同时监听 `v*` tag。否决：同一 tag 触发两个并行 workflow 竞争创建/上传同一份 Draft Release 存在竞态风险，合并为单一 `.github/workflows/release.yml` 由汇总 job 原子创建/更新。

## Consequences

- 安装与升级路径绑定在 `HKCU`（`currentUser`），支持普通用户免 UAC 安装及同版本/测试版降级覆盖（`allowDowngrades: true`）。
- 构建脚本直接通过 Node 进程调用 `node_modules/@tauri-apps/cli/tauri.js` 并传入 JSON `--config`，避免 Windows `cmd.exe`/`npx` 转义破坏参数。
- 运行时层面的平台识别（`Waypoint Android` / `Waypoint iOS` / `Waypoint Windows` / `Waypoint macOS` / `Waypoint Linux`）与附件文件名清理（Windows 非法字符 `< > " | ? *` 及保留设备名 `CON`/`PRN`/`AUX`/`NUL`/`COM1`–`COM9`/`LPT1`–`LPT9`）在所有平台保持一致行为。
- 若未来需要引入 Windows 商业代码签名证书或 Azure Trusted Signing，只需在 CI/Release 环境注入 `WINDOWS_SIGN_COMMAND` 或 `WINDOWS_CERTIFICATE_THUMBPRINT` 等环境变量，无需改动构建脚本接口。
