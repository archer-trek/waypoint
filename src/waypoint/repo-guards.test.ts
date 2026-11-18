// @ts-expect-error Node.js built-in fs in Vitest test runner
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
// @ts-expect-error Node.js built-in path in Vitest test runner
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
    expect(gradleKts).toContain("isMinifyEnabled = true");
    expect(gradleKts).toContain("isShrinkResources = true");
    expect(gradleKts).toContain("WAYPOINT_ANDROID_KEYSTORE_PATH");
    expect(gradleKts).toContain("keystore.properties");

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
  });
});
