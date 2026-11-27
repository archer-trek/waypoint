# Android 与 macOS 采用 10 秒 UTC 纪元滴答作为统一单调构建号

为使测试包与正式包继续共用 `app.waypoint.client` 与同一签名证书以支持在个人设备上原地覆盖安装（保留 Matrix 登录态、「本地时间线」与「草稿」），Android `versionCode` 与 macOS `CFBundleVersion` 放弃原有的 `1000 + git rev-list --count HEAD` 计算方式，统一改为基于构建时刻 UTC 时间戳的无状态 10 秒滴答 `Math.floor(Date.now() / 10_000)`，并限定全路径有效范围为 `1..2_100_000_000`。打包脚本与 `Makefile` 统一支持 `--build-number` / `BUILD_NUMBER` 与 `WAYPOINT_BUILD_NUMBER`（Android 兼容 `WAYPOINT_ANDROID_VERSION_CODE`）显式覆写，并在传给 [build.gradle.kts](../../src-tauri/gen/android/app/build.gradle.kts) 后由 Gradle 对 `WAYPOINT_ANDROID_VERSION_CODE` / `-PwaypointVersionCode` 做同口径校验并在非法输入时立即失败；Windows 打包维持 [ADR-0033](./0033-windows-nsis-packaging-and-native-chrome.md) 的 `X.Y.Z` 与 `allowDowngrades: true`，不引入整数构建号。

## Considered Options

- **继续使用 `1000 + git rev-list --count HEAD`**：否决。仓库采用 squash merge（[git-workflow.md](../agents/git-workflow.md)），特性分支多提交打测试包后合并回 `main` 时提交数反而回退，导致 Android 原地覆盖正式包触发 `INSTALL_FAILED_VERSION_DOWNGRADE`；多分支并行、同 commit 重打、本地未提交改动与 shallow clone 同样破坏单调性，且迫使 CI/Release 额外拉取 `fetch-depth: 0`。
- **将测试包拆分为独立 App ID（如 `app.waypoint.client.test`）双开共存**：否决。测试包无法直接验证真实设备上已有数据的原地升级路径，还会产生额外的 Matrix 设备登录与测试清理成本，且测试包自身在多分支和本地重打间仍需单调号。
- **使用中心化单调计数器（GitHub Actions `run_number` 或检入仓库版本文件）**：否决。`ci.yml` 与 `release.yml` 的 `run_number` 相互独立，且无法覆盖本地 `make apk` / `make dmg` 打包；检入版本文件会引入分支合并冲突与 squash 冲突。
- **采用 Semver 编码整数（如 `MAJOR*10000000 + MINOR*100000 + PATCH*1000 + build`）**：否决。同版本开发期仍需解决尾部 `build` 单调问题，且在分支上提前测试高版本号后无法再覆盖安装低补丁号热修复包。
- **采用 `YYMMDDHHMM` 可读日期编码**：否决。在 2026 年该值已达 `2,611,271,100`，超过 Android 32 位有符号整数上限 `2,147,483,647` 与 Google Play 上限 `2,100,000,000`，会直接构建或安装失败。
- **采用原始 Unix 秒数 `Math.floor(Date.now() / 1000)`**：否决。虽然当前小于上限，但将在 2036 年突破 Google Play `2,100,000,000` 上限（2038 年溢出 Int32），不适合作为长期号段。
- **采用自定义纪元相对秒数（如自 `2026-01-01` 起的秒数）**：否决。虽然寿命约 66 年且粒度为 1 秒，但引入需要额外记忆的魔法纪元常量；在已装过 `1079` 的设备上，10 秒滴答已足够覆盖单次构建耗时并避免常量耦合。
- **采用 `YYMMDD` + 当日 90 秒槽位**：否决。90 秒粒度过粗，本地快速增量重打或连续 CI 触发易落在同一槽位生成重复号，不利于未来商店或 TestFlight 的严格递增要求。

## Consequences

- **不可逆的高号段基线**：`Math.floor(Date.now() / 10_000)` 当前约为 `1.8e8`（9 位整数），远高于历史最高 `1079`，且可使用至 2635 年同时兼容 Android OS、Google Play 与 Apple `CFBundleVersion` 规范；一旦设备上安装过新号段安装包，无法再降级回低于当前值的小号段（除非卸载重装）。
- **天然支持原地验收与时间回滚**：无论是本地构建、特性分支 CI 测试包还是 `main` 正式包，只要构建时间靠后，构建号就严格增大；若特性分支测试包出现问题，只需切回 `main` 重新打包即可凭借更新的构建号原地覆盖回退，无需清数据卸载。
- **时间可溯源与可复现逃生口**：任意构建号均可通过 `new Date(buildNumber * 10_000).toISOString()` 直接还原 UTC 构建时间；需要可复现构建时，可通过 `--build-number <int>`、`Makefile` `BUILD_NUMBER=<int>` 或 `WAYPOINT_BUILD_NUMBER`（Android 仍兼容 `WAYPOINT_ANDROID_VERSION_CODE`）显式指定。
- **严格校验与构建链路简化**：脚本与 [build.gradle.kts](../../src-tauri/gen/android/app/build.gradle.kts) 均对输入做 `1..2_100_000_000` 正整数校验（拒绝前导零、小数、负数与超限值），移除之前非法值静默回退到 `1000` 的隐患；同时清理 `build-common.mjs` 中的 `commitCount` 逻辑及 CI/Release 构建 job 中不再需要的 `fetch-depth: 0`（仅保留 `ci.yml` 的 `native-filter` 做 `git diff` 所需的全量历史）。
- **保持不变的契约**：`versionName`（`X.Y.Z-test.<shortSha>` / `X.Y.Z`）、macOS `CFBundleShortVersionString`、产物文件名、Windows 安装包策略以及 [GLOSSARY.md](../../GLOSSARY.md) 均不受影响。
