#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import {
  assertCommitCountSafe,
  compareVersionDesc,
  findFreshArtifact,
  formatSizeMb,
  normalizeSemver,
  parseBuildArgs,
  readGitInfo,
  readTauriConf,
  resolveOutputPath,
  ROOT_DIR,
  runTauriCli,
} from "./lib/build-common.mjs";

const ANDROID_NDK_VERSION = "27.3.13750724";
const ANDROID_DIR = resolve(ROOT_DIR, "src-tauri/gen/android");
const ANDROID_APK_DIR = resolve(ANDROID_DIR, "app/build/outputs/apk/universal/release");
const KEYSTORE_PROPS_PATH = resolve(ANDROID_DIR, "keystore.properties");
const CI_DEBUG_DIR = resolve(ROOT_DIR, "scripts/android");
const CI_DEBUG_PROPS_PATH = resolve(CI_DEBUG_DIR, "ci-debug.properties");

function printHelp() {
  console.log(`Build Waypoint single-ABI (arm64-v8a) Android APK

Usage:
  node scripts/build-android-apk.mjs [options]

Options:
  --out <path>             Write final APK to exact file path
  --out-dir <dir>          Write final APK into directory using computed filename
  --release                Build release filename without -test.<shortSha> suffix
  --version <semver>       Override versionName base semver (e.g. 0.1.0 or v0.1.0)
  --ci-debug               Sign with the committed CI debug key (installable sideload APK)
  --unsigned               Build a truly unsigned APK (not installable)
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

function readCiDebugSigning() {
  const props = readPropertiesFile(CI_DEBUG_PROPS_PATH);
  const storeFile = props.storeFile;
  const storePassword = props.storePassword;
  const keyAlias = props.keyAlias;
  const keyPassword = props.keyPassword;
  const storeType = props.storeType || "PKCS12";
  if (!storeFile || !storePassword || !keyAlias || !keyPassword) {
    throw new Error(`Incomplete CI debug signing config: ${CI_DEBUG_PROPS_PATH}`);
  }
  const keystorePath = resolve(CI_DEBUG_DIR, storeFile);
  if (!existsSync(keystorePath)) {
    throw new Error(`Missing CI debug keystore: ${keystorePath}`);
  }
  return { keystorePath, storePassword, keyAlias, keyPassword, storeType };
}

function resolveSigningMode(options) {
  if (options.unsigned && options.ciDebug) {
    throw new Error("Cannot specify both --unsigned and --ci-debug.");
  }
  if (options.release && options.ciDebug) {
    throw new Error(
      "Release Android builds cannot use the CI debug key. Set WAYPOINT_ANDROID_KEYSTORE_* or create src-tauri/gen/android/keystore.properties.",
    );
  }
  if (options.unsigned) return "unsigned";
  if (options.ciDebug) return "ci-debug";
  if (hasSigningConfigured()) return "keystore";
  if (options.release) {
    throw new Error(
      "Missing Android release signing config. Set WAYPOINT_ANDROID_KEYSTORE_* or create src-tauri/gen/android/keystore.properties. Omit --release to sign a sideload APK with the CI debug key.",
    );
  }
  return "ci-debug";
}

function resolveBuildPlan(options) {
  const signingMode = resolveSigningMode(options);
  const ciDebugSigning = signingMode === "ci-debug" ? readCiDebugSigning() : null;

  const { productName, baseVersion } = readTauriConf();
  const version = normalizeSemver(
    options.versionRaw ?? baseVersion,
    "Android",
    "Android versionName base requires strict X.Y.Z semver.",
  );

  const hasExplicitVersionCode = Boolean(process.env.WAYPOINT_ANDROID_VERSION_CODE?.trim());
  const { shortSha, commitCount, isShallow } = readGitInfo({ needCommitCount: true });
  const versionCode = hasExplicitVersionCode
    ? process.env.WAYPOINT_ANDROID_VERSION_CODE.trim()
    : String(1000 + (Number.isFinite(commitCount) ? commitCount : 1));

  const computedVersionName = options.release ? version : `${version}-test.${shortSha}`;
  const versionName = options.versionRaw
    ? computedVersionName
    : process.env.WAYPOINT_ANDROID_VERSION_NAME?.trim() || computedVersionName;

  const apkFilename =
    signingMode === "unsigned"
      ? `${productName}-${versionName}-arm64-unsigned.apk`
      : `${productName}-${versionName}-arm64.apk`;
  // CI debug signing post-signs the unsigned Gradle output so v1+v2+v3 are explicit.
  const sourceApkName =
    signingMode === "keystore" ? "app-universal-release.apk" : "app-universal-release-unsigned.apk";

  const outputPath = resolveOutputPath({
    outPath: options.outPath,
    outDir: options.outDir,
    defaultDir: ANDROID_APK_DIR,
    filename: apkFilename,
  });

  const tauriArgs = ["android", "build", "--target", "aarch64", "--apk", "--ci"];

  return {
    isShallow,
    hasExplicitVersionCode,
    sourceApkName,
    ciDebugSigning,
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

function signWithCiDebugKey(androidHome, apkPath, signing) {
  const apksigner = findBuildTool("apksigner", androidHome);
  if (!apksigner) {
    throw new Error(
      "apksigner not found in Android SDK build-tools; cannot sign the CI debug APK.",
    );
  }
  if (!signing) {
    throw new Error("CI debug signing config is missing.");
  }
  const signedPath = `${apkPath}.signed`;
  rmSync(signedPath, { force: true });
  execFileSync(
    apksigner,
    [
      "sign",
      "--ks",
      signing.keystorePath,
      "--ks-type",
      signing.storeType,
      "--ks-pass",
      `pass:${signing.storePassword}`,
      "--ks-key-alias",
      signing.keyAlias,
      "--key-pass",
      `pass:${signing.keyPassword}`,
      "--v1-signing-enabled",
      "true",
      "--v2-signing-enabled",
      "true",
      "--v3-signing-enabled",
      "true",
      "--v4-signing-enabled",
      "false",
      "--out",
      signedPath,
      apkPath,
    ],
    { encoding: "utf8" },
  );
  rmSync(apkPath, { force: true });
  renameSync(signedPath, apkPath);
  // minSdk 24 makes default verify ignore v1. Check v1 as API 23 so Xiaomi's
  // JAR-based parser still has a certificate (error 33 / packageInfo is null).
  const output = execFileSync(
    apksigner,
    ["verify", "--min-sdk-version", "23", "--verbose", "--print-certs", apkPath],
    { encoding: "utf8" },
  );
  const v1Ok = output.includes("Verified using v1 scheme (JAR signing): true");
  const v2Ok = output.includes("Verified using v2 scheme (APK Signature Scheme v2): true");
  if (!v1Ok || !v2Ok) {
    throw new Error(`CI debug APK is not sideload-installable (need v1 and v2).\n${output}`);
  }
  return output.trim();
}

function main() {
  let options;
  try {
    options = parseBuildArgs(process.argv.slice(2), {
      allowTarget: false,
      allowUnsigned: true,
      allowCiDebug: true,
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
  const { plan, isShallow, hasExplicitVersionCode, sourceApkName, ciDebugSigning } = resolved;

  if (options.dryRun) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }

  let signerOutput = "";
  let soEntries = [];
  try {
    if (!hasExplicitVersionCode) {
      assertCommitCountSafe({
        isShallow,
        release: plan.release,
        label: "Android versionCode",
      });
    }

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
      ...(plan.signingMode === "unsigned" || plan.signingMode === "ci-debug"
        ? { WAYPOINT_ANDROID_UNSIGNED: "1" }
        : {}),
    };
    if (plan.signingMode === "ci-debug") {
      delete env.WAYPOINT_ANDROID_KEYSTORE_PATH;
      delete env.WAYPOINT_ANDROID_KEYSTORE_PASSWORD;
      delete env.WAYPOINT_ANDROID_KEY_ALIAS;
      delete env.WAYPOINT_ANDROID_KEY_PASSWORD;
      delete env.WAYPOINT_ANDROID_KEYSTORE_TYPE;
    }

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

    if (plan.signingMode === "ci-debug") {
      signerOutput = signWithCiDebugKey(androidHome, plan.outputPath, ciDebugSigning);
    } else if (plan.signingMode === "keystore") {
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
