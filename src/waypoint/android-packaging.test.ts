import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const ROOT_DIR = process.cwd();
const SCRIPT_PATH = resolve(ROOT_DIR, "scripts/build-android-apk.mjs");
const KEYSTORE_PROPS_PATH = resolve(ROOT_DIR, "src-tauri/gen/android/keystore.properties");

const ANDROID_ENV_KEYS = [
  "WAYPOINT_ANDROID_KEYSTORE_PATH",
  "WAYPOINT_ANDROID_KEYSTORE_PASSWORD",
  "WAYPOINT_ANDROID_KEY_ALIAS",
  "WAYPOINT_ANDROID_KEY_PASSWORD",
  "WAYPOINT_ANDROID_VERSION_CODE",
  "WAYPOINT_ANDROID_VERSION_NAME",
] as const;

function runBuildScript(args: string[], extraEnv: Record<string, string | undefined> = {}) {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const key of ANDROID_ENV_KEYS) {
    delete env[key];
  }
  for (const [key, value] of Object.entries(extraEnv)) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }
  return spawnSync("node", [SCRIPT_PATH, ...args], {
    cwd: ROOT_DIR,
    env,
    encoding: "utf8",
  }) as { status: number | null; stdout: string; stderr: string };
}

describe("build-android-apk CLI", () => {
  test("resolves signed default plan in --dry-run mode with WAYPOINT_ANDROID_KEYSTORE_* env vars", () => {
    const tauriConf = JSON.parse(
      readFileSync(resolve(ROOT_DIR, "src-tauri/tauri.conf.json"), "utf8"),
    ) as { version: string; productName: string };

    const res = runBuildScript(["--dry-run"], {
      WAYPOINT_ANDROID_KEYSTORE_PATH: "/tmp/test.jks",
      WAYPOINT_ANDROID_KEYSTORE_PASSWORD: "secret",
      WAYPOINT_ANDROID_KEY_ALIAS: "waypoint",
      WAYPOINT_ANDROID_KEY_PASSWORD: "secret",
    });
    expect(res.status, res.stderr).toBe(0);

    const plan = JSON.parse(res.stdout) as {
      productName: string;
      abi: string;
      version: string;
      versionCode: string;
      versionName: string;
      release: boolean;
      signingMode: string;
      apkFilename: string;
      outputPath: string;
      tauriArgs: string[];
    };

    expect(plan.productName).toBe(tauriConf.productName);
    expect(plan.abi).toBe("arm64-v8a");
    expect(plan.version).toBe(tauriConf.version);
    expect(plan.versionCode).toMatch(/^\d+$/);
    expect(plan.versionName).toMatch(new RegExp(`^${tauriConf.version}-test\\.[0-9a-f]+$`));
    expect(plan.release).toBe(false);
    expect(plan.signingMode).toBe("keystore");
    expect(plan.apkFilename).toBe(`${tauriConf.productName}-${plan.versionName}-arm64.apk`);
    expect(plan.outputPath).toBe(
      resolve(ROOT_DIR, "src-tauri/gen/android/app/build/outputs/apk/universal/release", plan.apkFilename),
    );
    expect(plan.tauriArgs).toEqual(["android", "build", "--target", "aarch64", "--apk", "--ci"]);
  });

  test("resolves --ci-debug plan as an installable signed APK without printing the debug password", () => {
    const tauriConf = JSON.parse(
      readFileSync(resolve(ROOT_DIR, "src-tauri/tauri.conf.json"), "utf8"),
    ) as { version: string; productName: string };
    const props = readFileSync(resolve(ROOT_DIR, "scripts/android/ci-debug.properties"), "utf8");
    const password = props.match(/^storePassword=(.+)$/m)?.[1];
    expect(password).toBeTruthy();
    expect(existsSync(resolve(ROOT_DIR, "scripts/android/waypoint-ci-debug.p12"))).toBe(true);

    const res = runBuildScript(["--dry-run", "--ci-debug"]);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).not.toContain(password as string);

    const plan = JSON.parse(res.stdout) as {
      signingMode: string;
      versionName: string;
      apkFilename: string;
    };
    expect(plan.signingMode).toBe("ci-debug");
    expect(plan.versionName).toMatch(new RegExp(`^${tauriConf.version}-test\\.[0-9a-f]+$`));
    expect(plan.apkFilename).toBe(`${tauriConf.productName}-${plan.versionName}-arm64.apk`);
    expect(plan.apkFilename).not.toContain("unsigned");
  });

  test("resolves --unsigned plan without signing credentials", () => {
    const tauriConf = JSON.parse(
      readFileSync(resolve(ROOT_DIR, "src-tauri/tauri.conf.json"), "utf8"),
    ) as { version: string; productName: string };

    const res = runBuildScript(["--dry-run", "--unsigned"]);
    expect(res.status, res.stderr).toBe(0);

    const plan = JSON.parse(res.stdout) as {
      signingMode: string;
      versionName: string;
      apkFilename: string;
    };

    expect(plan.signingMode).toBe("unsigned");
    expect(plan.versionName).toMatch(new RegExp(`^${tauriConf.version}-test\\.[0-9a-f]+$`));
    expect(plan.apkFilename).toBe(`${tauriConf.productName}-${plan.versionName}-arm64-unsigned.apk`);
  });

  test("resolves --release, --version, --out-dir, explicit --out, and env overrides", () => {
    const releaseRes = runBuildScript([
      "--dry-run",
      "--unsigned",
      "--release",
      "--version",
      "v0.2.0",
      "--out-dir",
      "artifacts/android",
    ]);
    expect(releaseRes.status, releaseRes.stderr).toBe(0);

    const releasePlan = JSON.parse(releaseRes.stdout) as {
      version: string;
      versionName: string;
      release: boolean;
      apkFilename: string;
      outputPath: string;
    };
    expect(releasePlan.version).toBe("0.2.0");
    expect(releasePlan.versionName).toBe("0.2.0");
    expect(releasePlan.release).toBe(true);
    expect(releasePlan.apkFilename).toBe("Waypoint-0.2.0-arm64-unsigned.apk");
    expect(releasePlan.outputPath).toBe(
      resolve(ROOT_DIR, "artifacts/android/Waypoint-0.2.0-arm64-unsigned.apk"),
    );

    const overrideRes = runBuildScript(
      ["--dry-run", "--unsigned", "--out", "tmp/custom.apk"],
      {
        WAYPOINT_ANDROID_VERSION_CODE: "4200",
        WAYPOINT_ANDROID_VERSION_NAME: "0.9.9-rc.1",
      },
    );
    expect(overrideRes.status, overrideRes.stderr).toBe(0);
    const overridePlan = JSON.parse(overrideRes.stdout) as {
      versionCode: string;
      versionName: string;
      outputPath: string;
    };
    expect(overridePlan.versionCode).toBe("4200");
    expect(overridePlan.versionName).toBe("0.9.9-rc.1");
    expect(overridePlan.outputPath).toBe(resolve(ROOT_DIR, "tmp/custom.apk"));
  });

  test("rejects unknown args, invalid semver, --out + --out-dir conflict, and missing signing config", () => {
    const unknownArg = runBuildScript(["--dry-run", "--unsigned", "--bogus"]);
    expect(unknownArg.status).not.toBe(0);
    expect(unknownArg.stderr).toContain("Unknown argument");

    const badVersion = runBuildScript(["--dry-run", "--unsigned", "--version", "0.1.0-beta.1"]);
    expect(badVersion.status).not.toBe(0);
    expect(badVersion.stderr).toContain("Invalid Android version");

    const bothOut = runBuildScript([
      "--dry-run",
      "--unsigned",
      "--out",
      "a.apk",
      "--out-dir",
      "artifacts",
    ]);
    expect(bothOut.status).not.toBe(0);
    expect(bothOut.stderr).toContain("Cannot specify both --out and --out-dir");

    const ciDebugConflicts = runBuildScript(["--dry-run", "--ci-debug", "--unsigned"]);
    expect(ciDebugConflicts.status).not.toBe(0);
    expect(ciDebugConflicts.stderr).toContain("Cannot specify both --unsigned and --ci-debug");

    const releaseCiDebug = runBuildScript(["--dry-run", "--ci-debug", "--release"]);
    expect(releaseCiDebug.status).not.toBe(0);
    expect(releaseCiDebug.stderr).toContain("cannot use the CI debug key");

    if (!existsSync(KEYSTORE_PROPS_PATH)) {
      const fallback = runBuildScript(["--dry-run"]);
      expect(fallback.status, fallback.stderr).toBe(0);
      const fallbackPlan = JSON.parse(fallback.stdout) as { signingMode: string; apkFilename: string };
      expect(fallbackPlan.signingMode).toBe("ci-debug");
      expect(fallbackPlan.apkFilename).not.toContain("unsigned");

      const missingReleaseSigning = runBuildScript(["--dry-run", "--release"]);
      expect(missingReleaseSigning.status).not.toBe(0);
      expect(missingReleaseSigning.stderr).toContain("Missing Android release signing config");
    }
  });
});

describe("Android packaging entrypoints and CI workflow", () => {
  test("Makefile, package.json, AGENTS.md, and ci.yml expose Android build entrypoints", () => {
    const makefile = readFileSync(resolve(ROOT_DIR, "Makefile"), "utf8");
    expect(makefile).toContain("build-android-apk");
    expect(makefile).toContain("apk: build-android-apk");
    expect(makefile).toContain("scripts/build-android-apk.mjs");
    expect(makefile).toContain("UNSIGNED");
    expect(makefile).toMatch(/^\.PHONY:.*\bclean\b/m);
    expect(makefile).toMatch(/^clean:/m);
    const cleanSection = makefile.split(/^clean:/m)[1]?.split(/^help:/m)[0] ?? "";
    expect(cleanSection).not.toContain("node_modules");
    expect(cleanSection).not.toContain("keystore.properties");

    const pkg = JSON.parse(readFileSync(resolve(ROOT_DIR, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    expect(pkg.scripts?.["build:android"]).toBe("node scripts/build-android-apk.mjs");

    const agentsMd = readFileSync(resolve(ROOT_DIR, "AGENTS.md"), "utf8");
    expect(agentsMd).toContain("make build-android-apk");
    expect(agentsMd).toContain("scripts/build-android-apk.mjs");

    const ciYml = readFileSync(resolve(ROOT_DIR, ".github/workflows/ci.yml"), "utf8");
    expect(ciYml).toContain("rust-checks:");
    expect(ciYml).toContain("if: needs.native-filter.outputs.run_rust == 'true'");
    expect(ciYml).toContain("key: linux-rust");
    expect(ciYml).toContain("android-build:");
    expect(ciYml).toContain("if: needs.native-filter.outputs.run_android == 'true'");
    expect(ciYml).toContain("key: android-aarch64");
    const androidBuildSection = ciYml.split("\n  android-build:")[1]?.split("\n  macos-build:")[0] ?? "";
    expect(androidBuildSection).not.toContain("libwebkit2gtk");
    expect(ciYml).toContain("gradle/actions/setup-gradle@v6");
    expect(ciYml).toContain("cargo fmt --check");
    expect(ciYml).toContain("cargo clippy --all-targets -- -D warnings");
    expect(ciYml).toContain("node scripts/build-android-apk.mjs --ci-debug --out-dir artifacts/android");
    expect(ciYml).not.toContain("node scripts/build-android-apk.mjs --unsigned");
    const gradleKts = readFileSync(
      resolve(ROOT_DIR, "src-tauri/gen/android/app/build.gradle.kts"),
      "utf8",
    );
    expect(gradleKts).toContain("enableV1Signing = true");
    expect(gradleKts).toContain("enableV2Signing = true");
    expect(gradleKts).toContain("enableV3Signing = true");
    expect(androidBuildSection).toContain("archive: false");
    expect(androidBuildSection).not.toContain("waypoint-android-apk");
  });
});
