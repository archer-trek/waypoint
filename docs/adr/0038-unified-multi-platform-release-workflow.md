# 统一多端两段式发版流程（Release PR + 单次 Tag 原子汇总）

Waypoint 将发版流程收敛为「版本准备（Release PR）→ 合入 `main` 后打 `vX.Y.Z` tag → 多端并行打包并原子汇总至同一份 Draft GitHub Release」的两段式闭环。同一份共享脚本（[prepare-release.mjs](../../scripts/prepare-release.mjs) 与 [release-version.mjs](../../scripts/lib/release-version.mjs)）同步维护 `package.json`、`package-lock.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml` 与 `src-tauri/Cargo.lock` 的严格三段式 `X.Y.Z` 版本号，既可本地运行也支持通过 [release-prepare.yml](../../.github/workflows/release-prepare.yml) 触发；合入 `main` 后由 [tag-release.mjs](../../scripts/tag-release.mjs) 校验工作区与 `CI` 通过状态并推送 `vX.Y.Z` tag，触发 [release.yml](../../.github/workflows/release.yml)（名称由 `Release Desktop` 更名为 `Release`）由 `meta` job 统一计算一次 [ADR-0037](./0037-monotonic-build-number-for-android-and-macos.md) 规定的 10 秒 UTC `build_number` 透传给 Android 与 macOS，并在前置 `verify`、`rust-checks` 及本次选中的全部平台（默认 Android `arm64-v8a` APK、macOS `arm64` DMG、Windows `x64` NSIS `.exe`）均通过后创建或增量更新同一份 Draft Release（补打部分平台时保留其余平台旧资产并重算完整 `SHA256SUMS.txt`）。

## Considered Options

- **在 `main` 上直接由脚本或 CI 提交版本号并同一步打 tag**：否决。仓库启用了 `main` 分支保护且强制通过 squash PR 线性合入（[git-workflow.md](../agents/git-workflow.md)），直接推送 `main` 会被分支保护拒绝；此外 GitHub Actions 默认 `GITHUB_TOKEN` 推送的提交或 tag 不会链式触发下游 `ci.yml` / `release.yml`，强行把「改版本号」与「打 tag 触发发布」合在单步依赖额外 Bot Token 才能跑通。
- **独立拆分 `release-android.yml` 与 `release-desktop.yml`**：否决。延续 [ADR-0033](./0033-windows-nsis-packaging-and-native-chrome.md) 否决拆分的理由，同一 `vX.Y.Z` tag 下多个并行 workflow 竞争创建/编辑同一份 GitHub Release 存在竞态，且 Android 与 macOS 各自独立计算 10 秒 UTC 滴答会导致同一次 Release 的两端构建号漂移。
- **Android 与 macOS 各自在打包 job 内独立计算 `build_number`**：否决。两台 runner 排队与编译耗时不同，同一次 `vX.Y.Z` 发布中两端 `versionCode` 与 `CFBundleVersion` 会相差数十个滴答，不利于跨端定位同一轮发布。
- **引入 `release-please` / `changesets` 或手写 `CHANGELOG.md`**：否决。Waypoint 为单仓 Tauri 客户端，单包多端版本同步远比多包 monorepo 发包简单；手工或机器人维护的 `CHANGELOG.md` 在 squash PR 流程下容易产生合并冲突，改用 [.github/release.yml](../../.github/release.yml) 配合 GitHub `gh release create --generate-notes` 即可自动输出分组后的 Release Notes。
- **打包全绿后自动 Publish GitHub Release 或接入应用内自动更新 / 应用商店**：否决。跨端安装包在未配置正式苹果公证与 Windows 商用代码签名证书前，以及 Android 侧载更新前，仍需人工在 Draft Release 中核对产物、签名与摘要后再点击 Publish；应用内自动更新（Tauri Updater）与第三方商店分发暂不纳入当前阶段，后续可在此闭环之上增量扩展。

## Consequences

- **五处版本号单一事实来源**：[repo-guards.test.ts](../../src/waypoint/repo-guards.test.ts) 与 `release.yml` 的 `meta` job 共同强制校验 `package.json`、`package-lock.json`（含 `packages[""]`）、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml` 与 `src-tauri/Cargo.lock`（`waypoint` 包）完全一致，阻断只改清单漏改锁文件的漂移。
- **无额外 Secret 即可本地全流程发版**：`npm run release:prepare` 与 `npm run release:tag` 依赖本地 `git` 与 `gh` 即可完成开 Release PR 与打 tag；CI 辅助入口 `release-prepare.yml` 优先读取可选 `RELEASE_BOT_TOKEN`，未配置时退回 `GITHUB_TOKEN` 并由 `GITHUB_STEP_SUMMARY` 提示人工补跑 PR 检查。
- **增量补打平台不丢失已有校验和**：通过 `workflow_dispatch` 选择 `desktop` / `android` / `macos` / `windows` 对同一 `RELEASE_TAG` 的 Draft Release 补打时，`draft-release` job 先拉取 Draft 中已存在资产并与本次新包合并后再重算 `SHA256SUMS.txt`（已正式 Publish 的 Release 仍拒绝覆写）。
- **保持不变的边界**：暂不包含 iOS（尚无 `src-tauri/gen/apple`）与 Linux 发布；暂不支持 `-rc.N` 预发布 tag（开发期验收继续使用 `ci.yml` 产出的 `-test.<shortSha>` 包）；[GLOSSARY.md](../../GLOSSARY.md) 保持只描述 Owner 领域概念而不收录工程发布术语。
