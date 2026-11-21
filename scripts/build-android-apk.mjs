#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(SCRIPT_DIR, "..");
const ANDROID_DIR = resolve(ROOT_DIR, "src-tauri/gen/android");
const KEYSTORE_PROPS_PATH = resolve(ANDROID_DIR, "keystore.properties");
const DEFAULT_RELEASE_APK = resolve(
  ANDROID_DIR,
  "app/build/outputs/apk/universal/release/app-universal-release.apk",
);

function parseArgs(argv) {
  let outPath;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--out" && argv[i + 1]) {
      outPath = resolve(ROOT_DIR, argv[i + 1]);
      i += 1;
    }
  }
  return { outPath };
}

function readGitInfo() {
  const shortSha = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
    cwd: ROOT_DIR,
    encoding: "utf8",
  }).trim();
  const commitCount = Number.parseInt(
    execFileSync("git", ["rev-list", "--count", "HEAD"], {
      cwd: ROOT_DIR,
      encoding: "utf8",
    }).trim(),
    10,
  );
  return { shortSha, commitCount };
}

function readBaseVersion() {
  const conf = JSON.parse(
    readFileSync(resolve(ROOT_DIR, "src-tauri/tauri.conf.json"), "utf8"),
  );
  return typeof conf.version === "string" && conf.version.trim()
    ? conf.version.trim()
    : "0.1.0";
}

function hasSigningConfigured() {
  const hasEnv =
    Boolean(process.env.WAYPOINT_ANDROID_KEYSTORE_PATH?.trim()) &&
    Boolean(process.env.WAYPOINT_ANDROID_KEYSTORE_PASSWORD?.trim()) &&
    Boolean(process.env.WAYPOINT_ANDROID_KEY_ALIAS?.trim()) &&
    Boolean(process.env.WAYPOINT_ANDROID_KEY_PASSWORD?.trim());
  return hasEnv || existsSync(KEYSTORE_PROPS_PATH);
}

function findApksigner() {
  const sdkRoots = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    resolve(homedir(), "Android/Sdk"),
  ].filter(Boolean);

  for (const sdk of sdkRoots) {
    const btDir = resolve(sdk, "build-tools");
    if (!existsSync(btDir)) continue;
    const versions = readdirSync(btDir).sort().reverse();
    for (const ver of versions) {
      const candidate = resolve(btDir, ver, "apksigner");
      if (existsSync(candidate)) return candidate;
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

function main() {
  const { outPath } = parseArgs(process.argv.slice(2));
  if (!hasSigningConfigured()) {
    console.error(
      "Missing Android release signing config. Set WAYPOINT_ANDROID_KEYSTORE_* env vars or create src-tauri/gen/android/keystore.properties.",
    );
    process.exit(1);
  }

  const { shortSha, commitCount } = readGitInfo();
  const baseVersion = readBaseVersion();
  const versionCode =
    process.env.WAYPOINT_ANDROID_VERSION_CODE?.trim() ||
    String(1000 + (Number.isFinite(commitCount) ? commitCount : 1));
  const versionName =
    process.env.WAYPOINT_ANDROID_VERSION_NAME?.trim() ||
    `${baseVersion}-test.${shortSha}`;

  cleanOtherAbiJniLibs();

  const androidHome =
    process.env.ANDROID_HOME?.trim() ||
    process.env.ANDROID_SDK_ROOT?.trim() ||
    resolve(homedir(), "Android/Sdk");
  const ndkHome =
    process.env.NDK_HOME?.trim() ||
    process.env.ANDROID_NDK_HOME?.trim() ||
    resolve(androidHome, "ndk/27.3.13750724");
  const javaHome =
    process.env.JAVA_HOME?.trim() ||
    (existsSync("/usr/lib/jvm/java-17-openjdk-arm64")
      ? "/usr/lib/jvm/java-17-openjdk-arm64"
      : undefined);

  const env = {
    ...process.env,
    ...(androidHome && existsSync(androidHome)
      ? { ANDROID_HOME: androidHome, ANDROID_SDK_ROOT: androidHome }
      : {}),
    ...(ndkHome && existsSync(ndkHome)
      ? { NDK_HOME: ndkHome, ANDROID_NDK_HOME: ndkHome }
      : {}),
    ...(javaHome ? { JAVA_HOME: javaHome } : {}),
    WAYPOINT_ANDROID_ABI_FILTERS: "arm64-v8a",
    WAYPOINT_ANDROID_VERSION_CODE: versionCode,
    WAYPOINT_ANDROID_VERSION_NAME: versionName,
  };

  console.log(
    `Building single-ABI (arm64-v8a) signed APK: versionCode=${versionCode}, versionName=${versionName}`,
  );
  const build = spawnSync(
    "npx",
    ["tauri", "android", "build", "--target", "aarch64", "--apk"],
    {
      cwd: ROOT_DIR,
      env,
      stdio: "inherit",
    },
  );
  if (build.status !== 0) {
    process.exit(build.status ?? 1);
  }

  if (!existsSync(DEFAULT_RELEASE_APK)) {
    console.error(`Expected APK not found at ${DEFAULT_RELEASE_APK}`);
    process.exit(1);
  }

  const finalApk =
    outPath ??
    resolve(
      ANDROID_DIR,
      `app/build/outputs/apk/universal/release/waypoint-${versionName}-arm64.apk`,
    );
  mkdirSync(dirname(finalApk), { recursive: true });
  if (finalApk !== DEFAULT_RELEASE_APK) {
    copyFileSync(DEFAULT_RELEASE_APK, finalApk);
  }

  const entries = execFileSync("unzip", ["-Z1", finalApk], {
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean);
  const soEntries = entries.filter((name) => name.startsWith("lib/") && name.endsWith(".so"));
  const nonArm64 = soEntries.filter((name) => !name.startsWith("lib/arm64-v8a/"));
  if (soEntries.length === 0 || nonArm64.length > 0) {
    console.error(`Unexpected native library ABIs in APK: ${soEntries.join(", ")}`);
    process.exit(1);
  }

  const apksigner = findApksigner();
  let signerOutput = "";
  if (apksigner) {
    signerOutput = execFileSync(apksigner, ["verify", "--print-certs", finalApk], {
      encoding: "utf8",
    }).trim();
  }

  const sizeBytes = statSync(finalApk).size;
  const sizeMb = (sizeBytes / (1024 * 1024)).toFixed(2);
  console.log("\n=== Android Test APK Ready ===");
  console.log(`Path: ${finalApk}`);
  console.log(`Size: ${sizeMb} MB (${sizeBytes} bytes)`);
  console.log(`ABIs: ${soEntries.join(", ")}`);
  console.log(`Version: ${versionName} (${versionCode})`);
  if (signerOutput) {
    console.log(signerOutput);
  }
}

main();
