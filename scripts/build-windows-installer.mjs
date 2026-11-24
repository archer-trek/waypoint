#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  statSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import {
  findFreshArtifact,
  formatSizeMb,
  normalizeSemver,
  parseBuildArgs,
  readGitInfo,
  readTauriConf,
  resolveCargoTargetDir,
  resolveOutputPath,
  runTauriCli,
} from "./lib/build-common.mjs";

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

function resolveTarget(rawTarget) {
  const resolved = TARGET_MAP[rawTarget];
  if (!resolved) {
    throw new Error(
      `Unsupported Windows target "${rawTarget}". Expected one of: x86_64-pc-windows-msvc (x64), aarch64-pc-windows-msvc (arm64).`,
    );
  }
  return resolved;
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
  const version = normalizeSemver(
    options.versionRaw ?? baseVersion,
    "Windows",
    "Bundle version requires strict X.Y.Z semver.",
  );
  const { shortSha } = readGitInfo();
  const { signingMode, windowsOverride } = resolveSigningConfig();

  const installerFilename = options.release
    ? `${productName}-${version}-${archLabel}-setup.exe`
    : `${productName}-${version}-test.${shortSha}-${archLabel}-setup.exe`;

  const cargoTargetDir = resolveCargoTargetDir();
  const nsisBundleDir = resolve(cargoTargetDir, target, "release/bundle/nsis");
  const outputPath = resolveOutputPath({
    outPath: options.outPath,
    outDir: options.outDir,
    defaultDir: nsisBundleDir,
    filename: installerFilename,
  });

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

function verifyInstallerPeHeader(filePath) {
  if (!existsSync(filePath)) {
    throw new Error(`Expected installer file missing at ${filePath}`);
  }
  const sizeBytes = statSync(filePath).size;
  if (sizeBytes < 64) {
    throw new Error(`Generated installer file is unexpectedly small (${sizeBytes} bytes): ${filePath}`);
  }
  const dosHeader = Buffer.alloc(64);
  const peSig = Buffer.alloc(4);
  const fd = openSync(filePath, "r");
  try {
    readSync(fd, dosHeader, 0, 64, 0);
    if (dosHeader[0] !== 0x4d || dosHeader[1] !== 0x5a) {
      throw new Error(`Generated installer does not have a valid PE MZ header: ${filePath}`);
    }
    const peOffset = dosHeader.readUInt32LE(0x3c);
    if (peOffset + 4 > sizeBytes) {
      throw new Error(`Generated installer has out-of-bounds PE header offset (${peOffset}): ${filePath}`);
    }
    readSync(fd, peSig, 0, 4, peOffset);
    if (peSig[0] !== 0x50 || peSig[1] !== 0x45 || peSig[2] !== 0x00 || peSig[3] !== 0x00) {
      throw new Error(`Generated installer does not have a valid PE\\0\\0 signature: ${filePath}`);
    }
  } finally {
    closeSync(fd);
  }
  return sizeBytes;
}

function verifyAuthenticodeSignature(filePath) {
  const verify = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$sig = Get-AuthenticodeSignature -FilePath $env:WAYPOINT_VERIFY_FILE; if ($sig.Status -ne 'Valid') { Write-Error \"Authenticode signature verification failed ($($sig.Status)): $($sig.StatusMessage)\"; exit 1 }",
    ],
    {
      env: { ...process.env, WAYPOINT_VERIFY_FILE: filePath },
      encoding: "utf8",
    },
  );
  if (verify.error) {
    throw verify.error;
  }
  if (verify.status !== 0) {
    throw new Error(verify.stderr?.trim() || `Authenticode verification failed for ${filePath}`);
  }
}

function main() {
  let options;
  try {
    options = parseBuildArgs(process.argv.slice(2), { defaultTarget: "x86_64-pc-windows-msvc" });
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

  let sizeBytes;
  try {
    console.log(
      `Building Windows NSIS installer (${plan.target}, ${plan.signingMode}): version=${plan.version}, out=${plan.outputPath}`,
    );
    const buildStartMs = Date.now();
    // Invoke Tauri CLI via Node directly so Windows cmd.exe does not mangle JSON --config quotes.
    runTauriCli(plan.tauriArgs);

    const tauriPrefix = `${plan.productName}_${plan.version}_`;
    const sourceInstaller = findFreshArtifact(
      plan.nsisBundleDir,
      (name) => name.startsWith(tauriPrefix) && name.endsWith("-setup.exe"),
      buildStartMs,
      `${tauriPrefix}*-setup.exe`,
    );

    mkdirSync(dirname(plan.outputPath), { recursive: true });
    if (sourceInstaller !== plan.outputPath) {
      copyFileSync(sourceInstaller, plan.outputPath);
    }

    sizeBytes = verifyInstallerPeHeader(plan.outputPath);
    if (plan.signingMode !== "unsigned") {
      verifyAuthenticodeSignature(plan.outputPath);
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  console.log("\n=== Windows NSIS Installer Ready ===");
  console.log(`Path: ${plan.outputPath}`);
  console.log(`Size: ${formatSizeMb(sizeBytes)} MB (${sizeBytes} bytes)`);
  console.log(`Target: ${plan.target}`);
  console.log(`Version: ${plan.version}`);
  console.log(`Signing: ${plan.signingMode}`);
}

main();
