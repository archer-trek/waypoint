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
});
