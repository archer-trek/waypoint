#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(SCRIPT_DIR, "..");
const TAURI_CONF_PATH = resolve(ROOT_DIR, "src-tauri/tauri.conf.json");
const TAURI_CLI_BIN = resolve(ROOT_DIR, "node_modules/@tauri-apps/cli/tauri.js");

const TARGET_MAP = {
  "x86_64-pc-windows-msvc": { target: "x86_64-pc-windows-msvc", archLabel: "x64" },
  x64: { target: "x86_64-pc-windows-msvc", archLabel: "x64" },
  "aarch64-pc-windows-msvc": { target: "aarch64-pc-windows-msvc", archLabel: "arm64" },
  arm64: { target: "aarch64-pc-windows-msvc", archLabel: "arm64" },
};

function printHelp() {
  console.log(`Build Waypoint Windows NSIS installer

Usage:
  node scripts/build-windows-installer.mjs [options]

Options:
  --target <triple|alias>  x86_64-pc-windows-msvc (x64, default), aarch64-pc-windows-msvc (arm64)
  --out <path>             Write final installer .exe to exact file path
  --out-dir <dir>          Write final installer .exe into directory using computed filename
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
    targetRaw: "x86_64-pc-windows-msvc",
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
      `Unsupported Windows target "${rawTarget}". Expected one of: x86_64-pc-windows-msvc (x64), aarch64-pc-windows-msvc (arm64).`,
    );
  }
  return resolved;
}

function normalizeSemver(rawVersion) {
  const stripped = rawVersion.trim().replace(/^v/i, "");
  if (!/^\d+\.\d+\.\d+$/.test(stripped)) {
    throw new Error(
      `Invalid Windows version "${rawVersion}". Bundle version requires strict X.Y.Z semver.`,
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

function readGitShortSha() {
  return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
    cwd: ROOT_DIR,
    encoding: "utf8",
  }).trim();
}

function resolveSigningConfig() {
  const signCommand = process.env.WINDOWS_SIGN_COMMAND?.trim();
  if (signCommand) {
    if (!signCommand.includes("%1")) {
      throw new Error(
        'WINDOWS_SIGN_COMMAND must contain the "%1" placeholder for the target binary path.',
      );
    }
    return {
      signingMode: "custom-command",
      windowsOverride: { signCommand },
    };
  }

  const certificateThumbprint = process.env.WINDOWS_CERTIFICATE_THUMBPRINT?.trim();
  if (certificateThumbprint) {
    const digestAlgorithm = process.env.WINDOWS_DIGEST_ALGORITHM?.trim() || "sha256";
    const timestampUrl = process.env.WINDOWS_TIMESTAMP_URL?.trim();
    const tspRaw = process.env.WINDOWS_TSP?.trim().toLowerCase();
    const tsp = tspRaw === "true" || tspRaw === "1";

    return {
      signingMode: "thumbprint",
      windowsOverride: {
        certificateThumbprint,
        digestAlgorithm,
        ...(timestampUrl ? { timestampUrl } : {}),
        ...(tsp ? { tsp: true } : {}),
      },
    };
  }

  return {
    signingMode: "unsigned",
    windowsOverride: null,
  };
}

function resolveBuildPlan(options) {
  const { target, archLabel } = resolveTarget(options.targetRaw);
  const { productName, baseVersion } = readTauriConf();
  const version = normalizeSemver(options.versionRaw ?? baseVersion);
  const shortSha = readGitShortSha();
  const { signingMode, windowsOverride } = resolveSigningConfig();

  const installerFilename = options.release
    ? `${productName}-${version}-${archLabel}-setup.exe`
    : `${productName}-${version}-test.${shortSha}-${archLabel}-setup.exe`;

  const nsisBundleDir = resolve(ROOT_DIR, "src-tauri/target", target, "release/bundle/nsis");
  const outputPath = options.outPath
    ? resolve(ROOT_DIR, options.outPath)
    : options.outDir
      ? resolve(ROOT_DIR, options.outDir, installerFilename)
      : resolve(nsisBundleDir, installerFilename);

  const configOverride = JSON.stringify({
    version,
    ...(windowsOverride ? { bundle: { windows: windowsOverride } } : {}),
  });

  const tauriArgs = [
    "build",
    "--target",
    target,
    "--bundles",
    "nsis",
    "--ci",
    "--config",
    configOverride,
  ];

  return {
    productName,
    target,
    archLabel,
    version,
    release: options.release,
    signingMode,
    installerFilename,
    nsisBundleDir,
    outputPath,
    tauriArgs,
  };
}

function findGeneratedInstaller(nsisBundleDir, productName, version, buildStartMs) {
  if (!existsSync(nsisBundleDir)) {
    throw new Error(`Expected NSIS bundle directory not found: ${nsisBundleDir}`);
  }
  const tauriPrefix = `${productName}_${version}_`;
  const candidates = readdirSync(nsisBundleDir)
    .filter((name) => name.startsWith(tauriPrefix) && name.endsWith("-setup.exe"))
    .map((name) => {
      const fullPath = resolve(nsisBundleDir, name);
      return { fullPath, mtimeMs: statSync(fullPath).mtimeMs };
    })
    .filter((entry) => entry.mtimeMs >= buildStartMs - 1000)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  if (candidates.length === 0) {
    throw new Error(
      `No freshly generated ${tauriPrefix}*-setup.exe found in ${nsisBundleDir}`,
    );
  }
  return candidates[0].fullPath;
}

function verifyInstallerPeHeader(filePath) {
  if (!existsSync(filePath)) {
    throw new Error(`Expected installer file missing at ${filePath}`);
  }
  const sizeBytes = statSync(filePath).size;
  if (sizeBytes <= 2) {
    throw new Error(`Generated installer file is unexpectedly small (${sizeBytes} bytes): ${filePath}`);
  }
  const header = Buffer.alloc(2);
  const fd = openSync(filePath, "r");
  try {
    readSync(fd, header, 0, 2, 0);
  } finally {
    closeSync(fd);
  }
  if (header[0] !== 0x4d || header[1] !== 0x5a) {
    throw new Error(`Generated installer does not have a valid PE MZ header: ${filePath}`);
  }
  return sizeBytes;
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

  if (process.platform !== "win32") {
    console.error(
      `Windows NSIS packaging must run on Windows (win32); current platform is ${process.platform}.`,
    );
    process.exit(1);
  }

  if (!existsSync(TAURI_CLI_BIN)) {
    console.error(`Tauri CLI entrypoint not found at ${TAURI_CLI_BIN}. Run npm ci first.`);
    process.exit(1);
  }

  console.log(
    `Building Windows NSIS installer (${plan.target}, ${plan.signingMode}): version=${plan.version}, out=${plan.outputPath}`,
  );
  const buildStartMs = Date.now();
  // Invoke Tauri CLI via Node directly so Windows cmd.exe does not mangle JSON --config quotes.
  const build = spawnSync(process.execPath, [TAURI_CLI_BIN, ...plan.tauriArgs], {
    cwd: ROOT_DIR,
    env: process.env,
    stdio: "inherit",
  });
  if (build.status !== 0) {
    process.exit(build.status ?? 1);
  }

  let sourceInstaller;
  try {
    sourceInstaller = findGeneratedInstaller(
      plan.nsisBundleDir,
      plan.productName,
      plan.version,
      buildStartMs,
    );
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  mkdirSync(dirname(plan.outputPath), { recursive: true });
  if (sourceInstaller !== plan.outputPath) {
    copyFileSync(sourceInstaller, plan.outputPath);
  }

  let sizeBytes;
  try {
    sizeBytes = verifyInstallerPeHeader(plan.outputPath);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  const sizeMb = (sizeBytes / (1024 * 1024)).toFixed(2);
  console.log("\n=== Windows NSIS Installer Ready ===");
  console.log(`Path: ${plan.outputPath}`);
  console.log(`Size: ${sizeMb} MB (${sizeBytes} bytes)`);
  console.log(`Target: ${plan.target}`);
  console.log(`Version: ${plan.version}`);
  console.log(`Signing: ${plan.signingMode}`);
}

main();
