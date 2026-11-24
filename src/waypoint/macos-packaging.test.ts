// @ts-expect-error Node.js built-in child_process in Vitest test runner
import { spawnSync } from "node:child_process";
// @ts-expect-error Node.js built-in fs in Vitest test runner
import { readFileSync } from "node:fs";
// @ts-expect-error Node.js built-in path in Vitest test runner
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const ROOT_DIR = (
  globalThis as unknown as { process: { cwd: () => string; platform: string; env: Record<string, string | undefined> } }
).process.cwd();
const HOST_PLATFORM = (
  globalThis as unknown as { process: { platform: string } }
).process.platform;
const SCRIPT_PATH = resolve(ROOT_DIR, "scripts/build-macos-dmg.mjs");

function runBuildScript(args: string[], extraEnv: Record<string, string | undefined> = {}) {
  const baseEnv = {
    ...(globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env,
    APPLE_SIGNING_IDENTITY: undefined,
    WAYPOINT_MACOS_RELEASE: undefined,
    WAYPOINT_MACOS_VERSION: undefined,
    WAYPOINT_MACOS_TARGET: undefined,
    WAYPOINT_MACOS_BUNDLE_VERSION: undefined,
    ...extraEnv,
  };
  return spawnSync("node", [SCRIPT_PATH, ...args], {
    cwd: ROOT_DIR,
    env: baseEnv,
    encoding: "utf8",
  }) as { status: number | null; stdout: string; stderr: string };
}

describe("build-macos-dmg CLI", () => {
  test("resolves default aarch64 test DMG plan in --dry-run mode", () => {
    const tauriConf = JSON.parse(
      readFileSync(resolve(ROOT_DIR, "src-tauri/tauri.conf.json"), "utf8"),
    ) as { version: string; productName: string };

    const res = runBuildScript(["--dry-run"]);
    expect(res.status, res.stderr).toBe(0);

    const plan = JSON.parse(res.stdout) as {
      target: string;
      archLabel: string;
      version: string;
      bundleVersion: string;
      release: boolean;
      signingMode: string;
      dmgFilename: string;
      outputPath: string;
      tauriArgs: string[];
    };

    expect(plan.target).toBe("aarch64-apple-darwin");
    expect(plan.archLabel).toBe("arm64");
    expect(plan.version).toBe(tauriConf.version);
    expect(plan.bundleVersion).toMatch(/^\d+$/);
    expect(plan.release).toBe(false);
    expect(plan.signingMode).toBe("ad-hoc");
    expect(plan.dmgFilename).toMatch(
      new RegExp(`^${tauriConf.productName}-${tauriConf.version}-test\\.[0-9a-f]+-arm64\\.dmg$`),
    );
    expect(plan.outputPath).toBe(
      resolve(ROOT_DIR, "src-tauri/target/aarch64-apple-darwin/release/bundle/dmg", plan.dmgFilename),
    );
    expect(plan.tauriArgs).toContain("build");
    expect(plan.tauriArgs).toContain("--target");
    expect(plan.tauriArgs).toContain("aarch64-apple-darwin");
    expect(plan.tauriArgs).toContain("--bundles");
    expect(plan.tauriArgs).toContain("dmg");
    expect(plan.tauriArgs).toContain("--ci");

    const configIndex = plan.tauriArgs.indexOf("--config");
    expect(configIndex).toBeGreaterThan(-1);
    const mergedConfig = JSON.parse(plan.tauriArgs[configIndex + 1]!) as {
      version: string;
      bundle: { macOS: { bundleVersion: string; signingIdentity?: string } };
    };
    expect(mergedConfig.version).toBe(tauriConf.version);
    expect(mergedConfig.bundle.macOS.bundleVersion).toBe(plan.bundleVersion);
    expect(mergedConfig.bundle.macOS.signingIdentity).toBe("-");
  });

  test("resolves release naming, universal target alias, --version, and --out-dir", () => {
    const res = runBuildScript([
      "--dry-run",
      "--target",
      "universal",
      "--release",
      "--version",
      "v0.2.0",
      "--out-dir",
      "artifacts/macos",
    ]);
    expect(res.status, res.stderr).toBe(0);

    const plan = JSON.parse(res.stdout) as {
      target: string;
      archLabel: string;
      version: string;
      release: boolean;
      dmgFilename: string;
      outputPath: string;
    };

    expect(plan.target).toBe("universal-apple-darwin");
    expect(plan.archLabel).toBe("universal");
    expect(plan.version).toBe("0.2.0");
    expect(plan.release).toBe(true);
    expect(plan.dmgFilename).toBe("Waypoint-0.2.0-universal.dmg");
    expect(plan.outputPath).toBe(resolve(ROOT_DIR, "artifacts/macos/Waypoint-0.2.0-universal.dmg"));
  });

  test("supports explicit --out path and switches signingMode when APPLE_SIGNING_IDENTITY is set", () => {
    const res = runBuildScript(
      ["--dry-run", "--target", "x64", "--out", "tmp/custom.dmg"],
      { APPLE_SIGNING_IDENTITY: "Developer ID Application: Example (TEAMID)" },
    );
    expect(res.status, res.stderr).toBe(0);

    const plan = JSON.parse(res.stdout) as {
      target: string;
      archLabel: string;
      signingMode: string;
      outputPath: string;
      tauriArgs: string[];
    };

    expect(plan.target).toBe("x86_64-apple-darwin");
    expect(plan.archLabel).toBe("x64");
    expect(plan.signingMode).toBe("identity");
    expect(plan.outputPath).toBe(resolve(ROOT_DIR, "tmp/custom.dmg"));

    const configIndex = plan.tauriArgs.indexOf("--config");
    const mergedConfig = JSON.parse(plan.tauriArgs[configIndex + 1]!) as {
      bundle: { macOS: { signingIdentity?: string } };
    };
    expect(mergedConfig.bundle.macOS.signingIdentity).toBeUndefined();
  });

  test("rejects unsupported target and non-semver version", () => {
    const badTarget = runBuildScript(["--dry-run", "--target", "armv7-apple-darwin"]);
    expect(badTarget.status).not.toBe(0);
    expect(badTarget.stderr).toContain("Unsupported macOS target");

    const badVersion = runBuildScript(["--dry-run", "--version", "0.1.0-test.123"]);
    expect(badVersion.status).not.toBe(0);
    expect(badVersion.stderr).toContain("Invalid macOS version");
  });

  if (HOST_PLATFORM !== "darwin") {
    test("fails fast on non-macOS hosts when not in --dry-run mode", () => {
      const res = runBuildScript([]);
      expect(res.status).not.toBe(0);
      expect(res.stderr).toContain("darwin");
    });
  }
});

describe("macOS packaging config, entrypoints, and workflows", () => {
  test("tauri.conf.json sets macOS minimumSystemVersion to 13.0 and keeps icon.icns", () => {
    const tauriConf = JSON.parse(
      readFileSync(resolve(ROOT_DIR, "src-tauri/tauri.conf.json"), "utf8"),
    ) as {
      bundle?: {
        icon?: string[];
        macOS?: { minimumSystemVersion?: string };
      };
    };

    expect(tauriConf.bundle?.macOS?.minimumSystemVersion).toBe("13.0");
    expect(tauriConf.bundle?.icon).toContain("icons/icon.icns");
  });

  test("Makefile, package.json, .gitignore, and AGENTS.md expose macOS DMG build entrypoints", () => {
    const makefile = readFileSync(resolve(ROOT_DIR, "Makefile"), "utf8");
    expect(makefile).toContain("build-macos-dmg");
    expect(makefile).toContain("dmg: build-macos-dmg");
    expect(makefile).toContain("scripts/build-macos-dmg.mjs");

    const pkg = JSON.parse(readFileSync(resolve(ROOT_DIR, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    expect(pkg.scripts?.["build:macos"]).toBe("node scripts/build-macos-dmg.mjs");

    const gitignore = readFileSync(resolve(ROOT_DIR, ".gitignore"), "utf8");
    expect(gitignore).toContain("*.dmg");

    const agentsMd = readFileSync(resolve(ROOT_DIR, "AGENTS.md"), "utf8");
    expect(agentsMd).toContain("make build-macos-dmg");
    expect(agentsMd).toContain("scripts/build-macos-dmg.mjs");
  });

  test("ci.yml runs macos-build on macos-latest gated by native-filter and uploads DMG artifact", () => {
    const ciYml = readFileSync(resolve(ROOT_DIR, ".github/workflows/ci.yml"), "utf8");
    expect(ciYml).toContain("src-tauri/|scripts/|\\.github/workflows/");
    expect(ciYml).toContain("macos-build:");
    expect(ciYml).toContain("runs-on: macos-latest");
    expect(ciYml).toContain("needs: native-filter");
    expect(ciYml).toContain("fetch-depth: 0");
    expect(ciYml).toContain("targets: aarch64-apple-darwin");
    expect(ciYml).toContain("node scripts/build-macos-dmg.mjs");
    expect(ciYml).toContain("actions/upload-artifact@v7");
    expect(ciYml).toContain(".dmg");
  });

  test("release-macos.yml builds release DMG on v* tags or manual dispatch as a draft release", () => {
    const releaseYml = readFileSync(
      resolve(ROOT_DIR, ".github/workflows/release-macos.yml"),
      "utf8",
    );
    expect(releaseYml).toContain("tags:");
    expect(releaseYml).toContain('"v*"');
    expect(releaseYml).toContain("workflow_dispatch:");
    expect(releaseYml).toContain("contents: write");
    expect(releaseYml).toContain("runs-on: macos-latest");
    expect(releaseYml).toContain("fetch-depth: 0");
    expect(releaseYml).toContain("universal-apple-darwin");
    expect(releaseYml).toContain("scripts/build-macos-dmg.mjs");
    expect(releaseYml).toContain("--release");
    expect(releaseYml).toContain("isDraft");
    expect(releaseYml).toContain("gh release create");
    expect(releaseYml).toContain("--draft");
  });
});
