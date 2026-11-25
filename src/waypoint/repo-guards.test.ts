import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import {
  classifyLoginFailure,
  credentialRejectedMessage,
  disconnectedMessage,
  formatMatrixActionFailure,
  transportFailureMessage,
} from "./matrix-errors";

const ROOT_DIR = (
  globalThis as unknown as { process: { cwd: () => string } }
).process.cwd();

function collectSourceFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectSourceFiles(fullPath));
    } else if (
      entry.isFile() &&
      (entry.name.endsWith(".tsx") || entry.name.endsWith(".ts")) &&
      !entry.name.endsWith(".d.ts") &&
      !entry.name.includes(".test.")
    ) {
      results.push(fullPath);
    }
  }
  return results;
}

describe("Repository, asset, and error-copy guards", () => {
  test("Tauri bundle icons, web favicon, and Android adaptive mipmaps all exist and are non-empty", () => {
    const tauriConf = JSON.parse(
      readFileSync(resolve(ROOT_DIR, "src-tauri/tauri.conf.json"), "utf-8"),
    ) as { bundle?: { icon?: string[] } };
    const bundleIcons = tauriConf.bundle?.icon ?? [];
    expect(bundleIcons.length).toBeGreaterThan(0);

    for (const relIcon of bundleIcons) {
      const fullPath = resolve(ROOT_DIR, "src-tauri", relIcon);
      expect(existsSync(fullPath), `${relIcon} should exist`).toBe(true);
      expect(statSync(fullPath).size, `${relIcon} should be non-empty`).toBeGreaterThan(0);
    }

    const indexHtml = readFileSync(resolve(ROOT_DIR, "index.html"), "utf-8");
    const faviconMatches = [...indexHtml.matchAll(/<link[^>]+rel="icon"[^>]+href="([^"]+)"/g)];
    expect(faviconMatches.length).toBeGreaterThan(0);
    for (const match of faviconMatches) {
      const href = match[1]!;
      const relPublic = href.startsWith("/") ? href.slice(1) : href;
      const fullPath = resolve(ROOT_DIR, "public", relPublic);
      expect(existsSync(fullPath), `public/${relPublic} should exist`).toBe(true);
      expect(statSync(fullPath).size).toBeGreaterThan(0);
    }

    const adaptiveXmlPath = resolve(
      ROOT_DIR,
      "src-tauri/gen/android/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml",
    );
    expect(existsSync(adaptiveXmlPath)).toBe(true);
    const adaptiveXml = readFileSync(adaptiveXmlPath, "utf-8");
    expect(adaptiveXml).toContain("@mipmap/ic_launcher_foreground");
    expect(adaptiveXml).toContain("@mipmap/ic_launcher_background");
    expect(adaptiveXml).toContain("@mipmap/ic_launcher_monochrome");

    const densities = ["mdpi", "hdpi", "xhdpi", "xxhdpi", "xxxhdpi"];
    const mipmapFiles = [
      "ic_launcher.png",
      "ic_launcher_round.png",
      "ic_launcher_foreground.png",
      "ic_launcher_background.png",
      "ic_launcher_monochrome.png",
    ];
    for (const density of densities) {
      for (const fileName of mipmapFiles) {
        const p = resolve(
          ROOT_DIR,
          `src-tauri/gen/android/app/src/main/res/mipmap-${density}/${fileName}`,
        );
        expect(existsSync(p), `Android mipmap-${density}/${fileName} should exist`).toBe(true);
        expect(statSync(p).size).toBeGreaterThan(0);
      }
    }
  });

  test("Matrix error formatters never leak raw English body.error, errcode, or HTTP status codes", () => {
    const canary = "CANARY_RAW_SERVER_ERROR_TEXT";
    const samples = [
      formatMatrixActionFailure("同步", {
        type: "response",
        status: 403,
        body: { errcode: "M_FORBIDDEN", error: canary },
      }),
      formatMatrixActionFailure("同步", {
        type: "response",
        status: 429,
        body: { errcode: "M_LIMIT_EXCEEDED", error: canary },
      }),
      formatMatrixActionFailure("同步", {
        type: "response",
        status: 502,
        body: { errcode: "M_UNKNOWN", error: canary },
      }),
      credentialRejectedMessage("同步", {
        type: "response",
        status: 401,
        body: { errcode: "M_UNKNOWN_TOKEN", error: canary },
      }),
      credentialRejectedMessage("同步", {
        type: "response",
        status: 403,
        body: { errcode: "M_USER_DEACTIVATED", error: canary },
      }),
      classifyLoginFailure({
        type: "response",
        status: 403,
        body: { errcode: "M_FORBIDDEN", error: canary },
      }).message,
      classifyLoginFailure({
        type: "response",
        status: 429,
        body: { errcode: "M_LIMIT_EXCEEDED", error: canary },
      }).message,
      classifyLoginFailure({
        type: "response",
        status: 503,
        body: { errcode: "M_UNKNOWN", error: canary },
      }).message,
      transportFailureMessage("连接", { type: "network" }),
      disconnectedMessage("操作"),
    ];

    for (const msg of samples) {
      expect(msg).not.toContain(canary);
      expect(msg).not.toMatch(/\bM_[A-Z_]+\b/);
      expect(msg).not.toMatch(/\b(?:401|403|429|502|503)\b/);
    }
  });

  test("UI source files avoid glossary-banned term 用户标识", () => {
    const targets = [
      resolve(ROOT_DIR, "src/App.tsx"),
      ...collectSourceFiles(resolve(ROOT_DIR, "src/components")),
      ...collectSourceFiles(resolve(ROOT_DIR, "src/waypoint")),
    ].sort();

    const violations: string[] = [];
    for (const filePath of targets) {
      const rel = relative(ROOT_DIR, filePath);
      const source = readFileSync(filePath, "utf-8");
      if (source.includes("用户标识")) {
        violations.push(rel);
      }
    }
    expect(violations).toEqual([]);
  });

  test("src-tauri/Cargo.toml preserves debug symbols on [profile.dev] and isolates slim build overrides", () => {
    const cargoToml = readFileSync(resolve(ROOT_DIR, "src-tauri/Cargo.toml"), "utf-8");
    const devSection = cargoToml.match(/\[profile\.dev\]([\s\S]*?)(?=\n\[|$)/)?.[1] ?? "";
    expect(devSection).not.toMatch(/\bstrip\s*=\s*true\b/);
    expect(devSection).not.toMatch(/\bdebug\s*=\s*0\b/);

    const releaseSection = cargoToml.match(/\[profile\.release\]([\s\S]*?)(?=\n\[|$)/)?.[1] ?? "";
    expect(releaseSection).toContain("opt-level = \"z\"");
    expect(releaseSection).toContain("lto = true");
    expect(releaseSection).toContain("strip = true");
    expect(releaseSection).toContain("panic = \"abort\"");
    expect(releaseSection).toContain("codegen-units = 1");

    const gradleKts = readFileSync(
      resolve(ROOT_DIR, "src-tauri/gen/android/app/build.gradle.kts"),
      "utf-8",
    );
    const extractBuildTypeBlock = (name: "debug" | "release") =>
      gradleKts.match(new RegExp(`getByName\\("${name}"\\)\\s*\\{([\\s\\S]*?)\\n\\s{8}\\}`))?.[1] ?? "";
    const debugBlock = extractBuildTypeBlock("debug");
    const releaseBlock = extractBuildTypeBlock("release");
    expect(debugBlock).toContain("isMinifyEnabled = false");
    expect(debugBlock).toContain('manifestPlaceholders["usesCleartextTraffic"] = "true"');
    expect(releaseBlock).toContain("isMinifyEnabled = true");
    expect(releaseBlock).toContain('manifestPlaceholders["usesCleartextTraffic"] = "false"');
    expect(releaseBlock).toContain("proguard-android-optimize.txt");
    expect(gradleKts).toContain("WAYPOINT_ANDROID_KEYSTORE_PATH");
    expect(gradleKts).toContain("keystore.properties");
    expect(gradleKts).toContain("enableV1Signing = true");

    const androidGitignore = readFileSync(
      resolve(ROOT_DIR, "src-tauri/gen/android/.gitignore"),
      "utf-8",
    );
    expect(androidGitignore).toContain("keystore.properties");
    expect(androidGitignore).toContain("*.jks");
    expect(androidGitignore).toContain("*.keystore");
  });

  test("Mobile viewport strategy, composer padding contract, and button transition hygiene are preserved", () => {
    const indexHtml = readFileSync(resolve(ROOT_DIR, "index.html"), "utf-8");
    expect(
      indexHtml,
      "index.html must maintain interactive-widget=resizes-visual for smooth soft-keyboard animation",
    ).toContain("interactive-widget=resizes-visual");
    expect(indexHtml).not.toContain("interactive-widget=resizes-content");

    const composerTsx = readFileSync(
      resolve(ROOT_DIR, "src/waypoint/workspace/ComposerView.tsx"),
      "utf-8",
    );
    expect(
      composerTsx,
      "ComposerView single-line mode must use explicit 48px horizontal padding for optical symmetry",
    ).toContain("px-[48px]");

    // Verify button positioning hygiene: avoid transition-all and keep constant bottom anchoring
    expect(
      composerTsx,
      "waypoint-attach-button must not use transition-all to prevent mode-switch jumps",
    ).not.toMatch(/waypoint-attach-button[^"]*\btransition-all\b/);
    expect(
      composerTsx,
      "waypoint-send-button must not use transition-all to prevent mode-switch jumps",
    ).not.toMatch(/waypoint-send-button[^"]*\btransition-all\b/);
    expect(composerTsx).toContain("bottom-[9px]");
    expect(composerTsx).toContain("bottom-[7px]");

    const workspaceTsx = readFileSync(
      resolve(ROOT_DIR, "src/waypoint/TopicsWorkspace.tsx"),
      "utf-8",
    );
    expect(
      workspaceTsx,
      "TopicsWorkspace singleLinePadX must match 2 * 48px composer horizontal padding",
    ).toContain("const singleLinePadX = 96;");

    const appCss = readFileSync(resolve(ROOT_DIR, "src/App.css"), "utf-8");
    expect(appCss).toContain("overflow: hidden;");
    expect(appCss).toContain("overscroll-behavior: none;");
    expect(appCss).toContain("position: fixed;");

    const topicHeaderTsx = readFileSync(
      resolve(ROOT_DIR, "src/waypoint/workspace/TopicHeaderView.tsx"),
      "utf-8",
    );
    expect(topicHeaderTsx).toContain("touch-none");

    const timelineTsx = readFileSync(
      resolve(ROOT_DIR, "src/waypoint/workspace/TimelineView.tsx"),
      "utf-8",
    );
    expect(timelineTsx).toContain("overscroll-contain");

    const mainActivityKt = readFileSync(
      resolve(
        ROOT_DIR,
        "src-tauri/gen/android/app/src/main/java/app/waypoint/client/MainActivity.kt",
      ),
      "utf-8",
    );
    expect(mainActivityKt).toContain("View.OVER_SCROLL_NEVER");
    expect(mainActivityKt).toContain("setOnScrollChangeListener");
  });

  test("Android shell resources lock monochrome cold-start themes, remove template/TV leftovers, and clean app_name quotes (#139)", () => {
    const stringsXml = readFileSync(
      resolve(ROOT_DIR, "src-tauri/gen/android/app/src/main/res/values/strings.xml"),
      "utf-8",
    );
    expect(stringsXml).toContain("<string name=\"app_name\">Waypoint</string>");
    expect(stringsXml).toContain("<string name=\"main_activity_title\">Waypoint</string>");
    expect(stringsXml).not.toContain("\"Waypoint\"");

    expect(
      existsSync(
        resolve(ROOT_DIR, "src-tauri/gen/android/app/src/main/res/layout/activity_main.xml"),
      ),
    ).toBe(false);

    const colorsXml = readFileSync(
      resolve(ROOT_DIR, "src-tauri/gen/android/app/src/main/res/values/colors.xml"),
      "utf-8",
    );
    expect(colorsXml).not.toMatch(/purple_|teal_|name="black"|name="white"/);
    expect(colorsXml).toContain("#FFFFFF");
    expect(colorsXml).toContain("#09090B");

    const dayThemeXml = readFileSync(
      resolve(ROOT_DIR, "src-tauri/gen/android/app/src/main/res/values/themes.xml"),
      "utf-8",
    );
    expect(dayThemeXml).toContain("@color/waypoint_background_light");

    const nightThemeXml = readFileSync(
      resolve(ROOT_DIR, "src-tauri/gen/android/app/src/main/res/values-night/themes.xml"),
      "utf-8",
    );
    expect(nightThemeXml).toContain("@color/waypoint_background_dark");

    const manifestXml = readFileSync(
      resolve(ROOT_DIR, "src-tauri/gen/android/app/src/main/AndroidManifest.xml"),
      "utf-8",
    );
    expect(manifestXml).not.toMatch(/leanback/i);
    expect(manifestXml).toContain("android:enableOnBackInvokedCallback=\"true\"");
    expect(manifestXml).toContain("androidx.core.content.FileProvider");

    const filePathsXml = readFileSync(
      resolve(ROOT_DIR, "src-tauri/gen/android/app/src/main/res/xml/file_paths.xml"),
      "utf-8",
    );
    expect(filePathsXml).not.toContain("<external-path");
    expect(filePathsXml).toContain("<cache-path");
    expect(filePathsXml).toContain("waypoint-media/");
  });

  test("Android network security config splits debug/release cleartext policy, R8 keep rules cover bridges, and CI gates native changes (#140)", () => {
    const manifestXml = readFileSync(
      resolve(ROOT_DIR, "src-tauri/gen/android/app/src/main/AndroidManifest.xml"),
      "utf-8",
    );
    expect(manifestXml).toContain('android:networkSecurityConfig="@xml/network_security_config"');

    const releaseNetSec = readFileSync(
      resolve(ROOT_DIR, "src-tauri/gen/android/app/src/main/res/xml/network_security_config.xml"),
      "utf-8",
    );
    expect(releaseNetSec).toContain('<base-config cleartextTrafficPermitted="false">');
    expect(releaseNetSec).toContain('<domain-config cleartextTrafficPermitted="true">');
    expect(releaseNetSec).toContain('<domain includeSubdomains="false">localhost</domain>');
    expect(releaseNetSec).toContain('<domain includeSubdomains="false">127.0.0.1</domain>');

    const debugNetSec = readFileSync(
      resolve(ROOT_DIR, "src-tauri/gen/android/app/src/debug/res/xml/network_security_config.xml"),
      "utf-8",
    );
    expect(debugNetSec).toContain('<base-config cleartextTrafficPermitted="true">');

    const proguardRules = readFileSync(
      resolve(ROOT_DIR, "src-tauri/gen/android/app/proguard-rules.pro"),
      "utf-8",
    );
    expect(proguardRules).toContain("@android.webkit.JavascriptInterface");
    expect(proguardRules).toContain("app.waypoint.client.MainActivity");
    expect(proguardRules).toContain("getMediaCacheDirPath()");
    expect(proguardRules).toContain("openMediaFile(java.lang.String, java.lang.String)");
    expect(proguardRules).toContain("setSystemAppearance(java.lang.String)");
    expect(proguardRules).toContain("MainActivity$WaypointAndroidBridge");
    expect(proguardRules).toContain("app.waypoint.client.Rust");
    expect(proguardRules).toContain("app.tauri.plugin.**");
    expect(proguardRules).toContain("app.tauri.opener.**");

    const ciYml = readFileSync(resolve(ROOT_DIR, ".github/workflows/ci.yml"), "utf-8");
    expect(ciYml).toContain("workflow_dispatch:");
    expect(ciYml).toContain("${BASE_SHA}...${HEAD_SHA}");
    expect(ciYml).toContain("src-tauri/");
    expect(ciYml).toContain(".github/workflows/");
    expect(ciYml).toContain("cargo test");
    expect(ciYml).toContain("./gradlew :app:testUniversalDebugUnitTest");
    expect(ciYml).toContain("node scripts/build-android-apk.mjs --ci-debug");
    expect(ciYml).not.toContain("node scripts/build-android-apk.mjs --unsigned");
    expect(ciYml).toContain("dexdump");
  });

  test("Version & toolchain single-source-of-truth and CI/Release workflow hygiene guards", () => {
    const pkg = JSON.parse(readFileSync(resolve(ROOT_DIR, "package.json"), "utf-8")) as {
      version: string;
    };
    const tauriConf = JSON.parse(
      readFileSync(resolve(ROOT_DIR, "src-tauri/tauri.conf.json"), "utf-8"),
    ) as { version: string };
    const cargoToml = readFileSync(resolve(ROOT_DIR, "src-tauri/Cargo.toml"), "utf-8");
    const cargoVersion = cargoToml.match(/^\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m)?.[1];

    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(tauriConf.version).toBe(pkg.version);
    expect(cargoVersion).toBe(pkg.version);

    const nvmrcPath = resolve(ROOT_DIR, ".nvmrc");
    expect(existsSync(nvmrcPath)).toBe(true);
    expect(readFileSync(nvmrcPath, "utf-8").trim()).toBe("26");

    const ciYml = readFileSync(resolve(ROOT_DIR, ".github/workflows/ci.yml"), "utf-8");
    const releaseYml = readFileSync(resolve(ROOT_DIR, ".github/workflows/release.yml"), "utf-8");

    expect(ciYml).toContain("node-version-file: .nvmrc");
    expect(ciYml).not.toContain("node-version: 26");
    expect(releaseYml).toContain("node-version-file: .nvmrc");
    expect(releaseYml).not.toContain("node-version: 26");

    expect(ciYml).not.toContain("actions: write");
    expect(ciYml).toContain("cancel-in-progress: ${{ github.event_name == 'pull_request' }}");

    const releaseHeader = releaseYml.split("\njobs:")[0] ?? "";
    expect(releaseHeader).toContain("contents: read");
    expect(releaseHeader).not.toContain("contents: write");
    expect(releaseYml).toContain("cancel-in-progress: false");
    const draftJobSection = releaseYml.split("\n  draft-release:")[1] ?? "";
    expect(draftJobSection).toContain("contents: write");
    expect(releaseYml.match(/contents:\s*write/g)?.length).toBe(1);

    const ndkVersion = "27.3.13750724";
    expect(ciYml).toContain(`ANDROID_NDK_VERSION: "${ndkVersion}"`);
    const gradleKts = readFileSync(
      resolve(ROOT_DIR, "src-tauri/gen/android/app/build.gradle.kts"),
      "utf-8",
    );
    expect(gradleKts).toContain(`ndkVersion = "${ndkVersion}"`);
    expect(gradleKts).toContain("compileSdk = 37");
    expect(ciYml).toContain('ANDROID_COMPILE_SDK_VERSION: "37.0"');

    const makefile = readFileSync(resolve(ROOT_DIR, "Makefile"), "utf-8");
    expect(makefile).toContain(`ANDROID_NDK_VERSION := ${ndkVersion}`);
    const androidScript = readFileSync(resolve(ROOT_DIR, "scripts/build-android-apk.mjs"), "utf-8");
    expect(androidScript).toContain(`ANDROID_NDK_VERSION = "${ndkVersion}"`);

    expect(existsSync(resolve(ROOT_DIR, ".github/dependabot.yml"))).toBe(true);
  });
});
