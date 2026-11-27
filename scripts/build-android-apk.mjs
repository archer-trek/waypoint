#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import {
  compareVersionDesc,
  findFreshArtifact,
  formatSizeMb,
  normalizeSemver,
  parseBuildArgs,
  readGitInfo,
  readTauriConf,
  resolveBuildNumber,
  resolveOutputPath,
  ROOT_DIR,
  runTauriCli,
} from "./lib/build-common.mjs";

const ANDROID_NDK_VERSION = "27.3.13750724";
const ANDROID_DIR = resolve(ROOT_DIR, "src-tauri/gen/android");
const ANDROID_APK_DIR = resolve(ANDROID_DIR, "app/build/outputs/apk/universal/release");
const KEYSTORE_PROPS_PATH = resolve(ANDROID_DIR, "keystore.properties");

function printHelp() {
  console.log(`Build Waypoint single-ABI (arm64-v8a) Android APK

Usage:
  node scripts/build-android-apk.mjs [options]

Options:
  --out <path>             Write final APK to exact file path
  --out-dir <dir>          Write final APK into directory using computed filename
  --release                Build release filename without -test.<shortSha> suffix
  --version <semver>       Override versionName base semver (e.g. 0.1.0 or v0.1.0)
  --build-number <int>     Override monotonic Android versionCode (1..2100000000)
  --unsigned               Build unsigned release APK without requiring keystore config
  --dry-run                Print resolved build plan JSON without building
  -h, --help               Show this help message`);
}

function readPropertiesFile(filePath) {
  const props = {};
  if (!existsSync(filePath)) return props;
  const raw = readFileSync(filePath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("!")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx <= 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (val) {
      props[key] = val;
    }
  }
  return props;
}

function hasSigningConfigured() {
  const props = readPropertiesFile(KEYSTORE_PROPS_PATH);
  const resolveProp = (envName, propName) =>
    Boolean(process.env[envName]?.trim() || props[propName]?.trim());
  return (
    resolveProp("WAYPOINT_ANDROID_KEYSTORE_PATH", "storeFile") &&
    resolveProp("WAYPOINT_ANDROID_KEYSTORE_PASSWORD", "storePassword") &&
    resolveProp("WAYPOINT_ANDROID_KEY_ALIAS", "keyAlias") &&
    resolveProp("WAYPOINT_ANDROID_KEY_PASSWORD", "keyPassword")
  );
}

function resolveExistingPath(candidates) {
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function resolveAndroidToolchainEnv() {
  const sdkCandidates = [
    process.env.ANDROID_HOME?.trim(),
    process.env.ANDROID_SDK_ROOT?.trim(),
    ...(process.platform === "darwin" ? [resolve(homedir(), "Library/Android/sdk")] : []),
    resolve(homedir(), "Android/Sdk"),
  ];
  const androidHome = resolveExistingPath(sdkCandidates);

  const ndkCandidates = [
    process.env.NDK_HOME?.trim(),
    process.env.ANDROID_NDK_HOME?.trim(),
    ...(androidHome ? [resolve(androidHome, "ndk", ANDROID_NDK_VERSION)] : []),
  ];
  const ndkHome = resolveExistingPath(ndkCandidates);

  let darwinJavaHome;
  if (process.platform === "darwin") {
    try {
      darwinJavaHome = execFileSync("/usr/libexec/java_home", ["-v", "17"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      darwinJavaHome = undefined;
    }
  }
  const javaCandidates = [
    process.env.JAVA_HOME?.trim(),
    darwinJavaHome,
    "/usr/lib/jvm/java-17-openjdk-arm64",
    "/usr/lib/jvm/java-17-openjdk-amd64",
  ];
  const javaHome = resolveExistingPath(javaCandidates);

  return { androidHome, ndkHome, javaHome };
}

function findBuildTool(toolName, androidHome) {
  const sdkRoots = [
    androidHome,
    process.env.ANDROID_HOME?.trim(),
    process.env.ANDROID_SDK_ROOT?.trim(),
    ...(process.platform === "darwin" ? [resolve(homedir(), "Library/Android/sdk")] : []),
    resolve(homedir(), "Android/Sdk"),
  ].filter(Boolean);

  const fileNames =
    process.platform === "win32"
      ? [`${toolName}.bat`, `${toolName}.exe`, toolName]
      : [toolName];

  for (const sdk of new Set(sdkRoots)) {
    const btDir = resolve(sdk, "build-tools");
    if (!existsSync(btDir)) continue;
    const versions = readdirSync(btDir).sort(compareVersionDesc);
    for (const ver of versions) {
      for (const fileName of fileNames) {
        const candidate = resolve(btDir, ver, fileName);
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  return null;
}

function cleanOtherAbiJniLibs() {
  const jniDir = resolve(ANDROID_DIR, "app/src/main/jniLibs");
  if (!existsSync(jniDir)) return;
  for (const abi of ["armeabi-v7a", "x86", "x86_64"]) {
    const dir = resolve(jniDir, abi);
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

function resolveBuildPlan(options) {
  const signingMode = options.unsigned ? "unsigned" : "keystore";
  if (!options.unsigned && !hasSigningConfigured()) {
    throw new Error(
      "Missing Android release signing config. Set WAYPOINT_ANDROID_KEYSTORE_* env vars, create src-tauri/gen/android/keystore.properties, or pass --unsigned.",
    );
  }

  const { productName, baseVersion } = readTauriConf();
  const version = normalizeSemver(
    options.versionRaw ?? baseVersion,
    "Android",
    "Android versionName base requires strict X.Y.Z semver.",
  );

  const { shortSha } = readGitInfo();
  const versionCode = resolveBuildNumber({
    buildNumberRaw: options.buildNumberRaw,
    platformEnvValue: process.env.WAYPOINT_ANDROID_VERSION_CODE,
    platformEnvName: "WAYPOINT_ANDROID_VERSION_CODE",
    sharedEnvValue: process.env.WAYPOINT_BUILD_NUMBER,
    label: "Android versionCode",
  });

  const computedVersionName = options.release ? version : `${version}-test.${shortSha}`;
  const versionName = options.versionRaw
    ? computedVersionName
    : process.env.WAYPOINT_ANDROID_VERSION_NAME?.trim() || computedVersionName;

  const apkFilename = options.unsigned
    ? `${productName}-${versionName}-arm64-unsigned.apk`
    : `${productName}-${versionName}-arm64.apk`;
  const sourceApkName = options.unsigned
    ? "app-universal-release-unsigned.apk"
    : "app-universal-release.apk";

  const outputPath = resolveOutputPath({
    outPath: options.outPath,
    outDir: options.outDir,
    defaultDir: ANDROID_APK_DIR,
    filename: apkFilename,
  });

  const tauriArgs = ["android", "build", "--target", "aarch64", "--apk", "--ci"];

  return {
    sourceApkName,
    plan: {
      productName,
      abi: "arm64-v8a",
      version,
      versionCode,
      versionName,
      release: options.release,
      signingMode,
      apkFilename,
      outputPath,
      tauriArgs,
    },
  };
}

function main() {
  let options;
  try {
    options = parseBuildArgs(process.argv.slice(2), {
      allowTarget: false,
      allowUnsigned: true,
      allowBuildNumber: true,
    });
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  if (options.help) {
    printHelp();
    return;
  }

  let resolved;
  try {
    resolved = resolveBuildPlan(options);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  const { plan, sourceApkName } = resolved;

  if (options.dryRun) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }

  let signerOutput = "";
  let soEntries = [];
  try {
    cleanOtherAbiJniLibs();

    const { androidHome, ndkHome, javaHome } = resolveAndroidToolchainEnv();
    const env = {
      ...process.env,
      ...(androidHome ? { ANDROID_HOME: androidHome, ANDROID_SDK_ROOT: androidHome } : {}),
      ...(ndkHome ? { NDK_HOME: ndkHome, ANDROID_NDK_HOME: ndkHome } : {}),
      ...(javaHome ? { JAVA_HOME: javaHome } : {}),
      WAYPOINT_ANDROID_ABI_FILTERS: "arm64-v8a",
      WAYPOINT_ANDROID_VERSION_CODE: plan.versionCode,
      WAYPOINT_ANDROID_VERSION_NAME: plan.versionName,
      ...(plan.signingMode === "unsigned" ? { WAYPOINT_ANDROID_UNSIGNED: "1" } : {}),
    };

    console.log(
      `Building single-ABI (arm64-v8a) ${plan.signingMode} APK: versionCode=${plan.versionCode}, versionName=${plan.versionName}, out=${plan.outputPath}`,
    );
    const buildStartMs = Date.now();
    runTauriCli(plan.tauriArgs, env);

    const sourceApk = findFreshArtifact(
      ANDROID_APK_DIR,
      (name) => name === sourceApkName,
      buildStartMs,
      sourceApkName,
    );

    mkdirSync(dirname(plan.outputPath), { recursive: true });
    if (sourceApk !== plan.outputPath) {
      copyFileSync(sourceApk, plan.outputPath);
    }

    const entries = execFileSync("unzip", ["-Z1", plan.outputPath], {
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean);
    soEntries = entries.filter((name) => name.startsWith("lib/") && name.endsWith(".so"));
    const nonArm64 = soEntries.filter((name) => !name.startsWith("lib/arm64-v8a/"));
    if (soEntries.length === 0 || nonArm64.length > 0) {
      throw new Error(`Unexpected native library ABIs in APK: ${soEntries.join(", ")}`);
    }

    if (plan.signingMode === "keystore") {
      const apksigner = findBuildTool("apksigner", androidHome);
      if (!apksigner) {
        throw new Error(
          "apksigner not found in Android SDK build-tools; cannot verify signed release APK.",
        );
      }
      signerOutput = execFileSync(apksigner, ["verify", "--print-certs", plan.outputPath], {
        encoding: "utf8",
      }).trim();
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  const sizeBytes = statSync(plan.outputPath).size;
  console.log("\n=== Android APK Ready ===");
  console.log(`Path: ${plan.outputPath}`);
  console.log(`Size: ${formatSizeMb(sizeBytes)} MB (${sizeBytes} bytes)`);
  console.log(`ABIs: ${soEntries.join(", ")}`);
  console.log(`Version: ${plan.versionName} (${plan.versionCode})`);
  console.log(`Signing: ${plan.signingMode}`);
  if (signerOutput) {
    console.log(signerOutput);
  }
}

main();
