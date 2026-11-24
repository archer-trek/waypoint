#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(SCRIPT_DIR, "..");
const TAURI_CONF_PATH = resolve(ROOT_DIR, "src-tauri/tauri.conf.json");

const TARGET_MAP = {
  "aarch64-apple-darwin": { target: "aarch64-apple-darwin", archLabel: "arm64" },
  arm64: { target: "aarch64-apple-darwin", archLabel: "arm64" },
  "x86_64-apple-darwin": { target: "x86_64-apple-darwin", archLabel: "x64" },
  x64: { target: "x86_64-apple-darwin", archLabel: "x64" },
  "universal-apple-darwin": { target: "universal-apple-darwin", archLabel: "universal" },
  universal: { target: "universal-apple-darwin", archLabel: "universal" },
};

function printHelp() {
  console.log(`Build Waypoint macOS DMG bundle

Usage:
  node scripts/build-macos-dmg.mjs [options]

Options:
  --target <triple|alias>  aarch64-apple-darwin (arm64, default), x86_64-apple-darwin (x64), universal-apple-darwin (universal)
  --out <path>             Write final DMG to exact file path
  --out-dir <dir>          Write final DMG into directory using computed filename
  --release                Build release filename without -test.<shortSha> suffix
  --version <semver>       Override bundle semver (e.g. 0.1.0 or v0.1.0)
  --dry-run                Print resolved build plan JSON without building
  -h, --help               Show this help message`);
}

function readNextFlagValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith("-")) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function parseArgs(argv) {
  const options = {
    targetRaw: "aarch64-apple-darwin",
    outPath: undefined,
    outDir: undefined,
    release: false,
    versionRaw: undefined,
    dryRun: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      options.help = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--release") {
      options.release = true;
    } else if (arg === "--target") {
      options.targetRaw = readNextFlagValue(argv, i, "--target");
      i += 1;
    } else if (arg === "--out") {
      options.outPath = readNextFlagValue(argv, i, "--out");
      i += 1;
    } else if (arg === "--out-dir") {
      options.outDir = readNextFlagValue(argv, i, "--out-dir");
      i += 1;
    } else if (arg === "--version") {
      options.versionRaw = readNextFlagValue(argv, i, "--version");
      i += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function resolveTarget(rawTarget) {
  const resolved = TARGET_MAP[rawTarget];
  if (!resolved) {
    throw new Error(
      `Unsupported macOS target "${rawTarget}". Expected one of: aarch64-apple-darwin (arm64), x86_64-apple-darwin (x64), universal-apple-darwin (universal).`,
    );
  }
  return resolved;
}

function normalizeSemver(rawVersion) {
  const stripped = rawVersion.trim().replace(/^v/i, "");
  if (!/^\d+\.\d+\.\d+$/.test(stripped)) {
    throw new Error(
      `Invalid macOS version "${rawVersion}". Apple CFBundleShortVersionString requires strict X.Y.Z semver.`,
    );
  }
  return stripped;
}

function readTauriConf() {
  const conf = JSON.parse(readFileSync(TAURI_CONF_PATH, "utf8"));
  const productName =
    typeof conf.productName === "string" && conf.productName.trim()
      ? conf.productName.trim()
      : "Waypoint";
  const baseVersion =
    typeof conf.version === "string" && conf.version.trim()
      ? conf.version.trim()
      : "0.1.0";
  return { productName, baseVersion };
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

function resolveBuildPlan(options) {
  const { target, archLabel } = resolveTarget(options.targetRaw);
  const { productName, baseVersion } = readTauriConf();
  const version = normalizeSemver(options.versionRaw ?? baseVersion);
  const { shortSha, commitCount } = readGitInfo();

  const bundleVersion = String(1000 + (Number.isFinite(commitCount) ? commitCount : 1));

  const dmgFilename = options.release
    ? `${productName}-${version}-${archLabel}.dmg`
    : `${productName}-${version}-test.${shortSha}-${archLabel}.dmg`;

  const dmgBundleDir = resolve(ROOT_DIR, "src-tauri/target", target, "release/bundle/dmg");
  const outputPath = options.outPath
    ? resolve(ROOT_DIR, options.outPath)
    : options.outDir
      ? resolve(ROOT_DIR, options.outDir, dmgFilename)
      : resolve(dmgBundleDir, dmgFilename);

  const hasSigningIdentity = Boolean(process.env.APPLE_SIGNING_IDENTITY?.trim());
  const signingMode = hasSigningIdentity ? "identity" : "ad-hoc";
  const macOsOverride = {
    bundleVersion,
    ...(hasSigningIdentity ? {} : { signingIdentity: "-" }),
  };
  const configOverride = JSON.stringify({
    version,
    bundle: {
      macOS: macOsOverride,
    },
  });

  const tauriArgs = [
    "build",
    "--target",
    target,
    "--bundles",
    "dmg",
    "--ci",
    "--config",
    configOverride,
  ];

  return {
    productName,
    target,
    archLabel,
    version,
    bundleVersion,
    release: options.release,
    signingMode,
    dmgFilename,
    dmgBundleDir,
    outputPath,
    tauriArgs,
  };
}

function findGeneratedDmg(dmgBundleDir, productName, version, buildStartMs) {
  if (!existsSync(dmgBundleDir)) {
    throw new Error(`Expected DMG bundle directory not found: ${dmgBundleDir}`);
  }
  const tauriPrefix = `${productName}_${version}_`;
  const candidates = readdirSync(dmgBundleDir)
    .filter((name) => name.startsWith(tauriPrefix) && name.endsWith(".dmg"))
    .map((name) => {
      const fullPath = resolve(dmgBundleDir, name);
      return { fullPath, mtimeMs: statSync(fullPath).mtimeMs };
    })
    .filter((entry) => entry.mtimeMs >= buildStartMs - 1000)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  if (candidates.length === 0) {
    throw new Error(
      `No freshly generated ${tauriPrefix}*.dmg found in ${dmgBundleDir}`,
    );
  }
  return candidates[0].fullPath;
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  if (options.help) {
    printHelp();
    return;
  }

  let plan;
  try {
    plan = resolveBuildPlan(options);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  if (options.dryRun) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }

  if (process.platform !== "darwin") {
    console.error(
      `macOS DMG packaging must run on macOS (darwin); current platform is ${process.platform}.`,
    );
    process.exit(1);
  }

  console.log(
    `Building macOS DMG (${plan.target}, ${plan.signingMode}): version=${plan.version} (${plan.bundleVersion}), out=${plan.outputPath}`,
  );
  const buildStartMs = Date.now();
  const build = spawnSync("npx", ["tauri", ...plan.tauriArgs], {
    cwd: ROOT_DIR,
    env: process.env,
    stdio: "inherit",
  });
  if (build.status !== 0) {
    process.exit(build.status ?? 1);
  }

  let sourceDmg;
  try {
    sourceDmg = findGeneratedDmg(
      plan.dmgBundleDir,
      plan.productName,
      plan.version,
      buildStartMs,
    );
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  mkdirSync(dirname(plan.outputPath), { recursive: true });
  if (sourceDmg !== plan.outputPath) {
    copyFileSync(sourceDmg, plan.outputPath);
  }

  const verify = spawnSync("hdiutil", ["verify", plan.outputPath], {
    encoding: "utf8",
  });
  if (verify.status !== 0) {
    console.error(verify.stderr || `hdiutil verify failed for ${plan.outputPath}`);
    process.exit(verify.status ?? 1);
  }

  const sizeBytes = statSync(plan.outputPath).size;
  const sizeMb = (sizeBytes / (1024 * 1024)).toFixed(2);
  console.log("\n=== macOS DMG Ready ===");
  console.log(`Path: ${plan.outputPath}`);
  console.log(`Size: ${sizeMb} MB (${sizeBytes} bytes)`);
  console.log(`Target: ${plan.target}`);
  console.log(`Version: ${plan.version} (${plan.bundleVersion})`);
  console.log(`Signing: ${plan.signingMode}`);
}

main();
