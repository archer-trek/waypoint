#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  assertCommitCountSafe,
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
  "aarch64-apple-darwin": { target: "aarch64-apple-darwin", archLabel: "arm64" },
  arm64: { target: "aarch64-apple-darwin", archLabel: "arm64" },
  "x86_64-apple-darwin": { target: "x86_64-apple-darwin", archLabel: "x64" },
  x64: { target: "x86_64-apple-darwin", archLabel: "x64" },
  "universal-apple-darwin": { target: "universal-apple-darwin", archLabel: "universal" },
  universal: { target: "universal-apple-darwin", archLabel: "universal" },
};

const EXPECTED_MACHO_ARCHS = {
  "aarch64-apple-darwin": ["arm64"],
  "x86_64-apple-darwin": ["x86_64"],
  "universal-apple-darwin": ["arm64", "x86_64"],
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

function resolveTarget(rawTarget) {
  const resolved = TARGET_MAP[rawTarget];
  if (!resolved) {
    throw new Error(
      `Unsupported macOS target "${rawTarget}". Expected one of: aarch64-apple-darwin (arm64), x86_64-apple-darwin (x64), universal-apple-darwin (universal).`,
    );
  }
  return resolved;
}

function resolveBuildPlan(options) {
  const { target, archLabel } = resolveTarget(options.targetRaw);
  const { productName, baseVersion } = readTauriConf();
  const version = normalizeSemver(
    options.versionRaw ?? baseVersion,
    "macOS",
    "Apple CFBundleShortVersionString requires strict X.Y.Z semver.",
  );
  const { shortSha, commitCount, isShallow } = readGitInfo({ needCommitCount: true });

  const bundleVersion = String(1000 + (Number.isFinite(commitCount) ? commitCount : 1));

  const dmgFilename = options.release
    ? `${productName}-${version}-${archLabel}.dmg`
    : `${productName}-${version}-test.${shortSha}-${archLabel}.dmg`;

  const cargoTargetDir = resolveCargoTargetDir();
  const dmgBundleDir = resolve(cargoTargetDir, target, "release/bundle/dmg");
  const outputPath = resolveOutputPath({
    outPath: options.outPath,
    outDir: options.outDir,
    defaultDir: dmgBundleDir,
    filename: dmgFilename,
  });

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
    isShallow,
    plan: {
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
    },
  };
}

function verifyAppBundle(appBundlePath, target) {
  if (!existsSync(appBundlePath)) {
    throw new Error(`Expected macOS .app bundle not found at ${appBundlePath}`);
  }
  const codesign = spawnSync("codesign", ["--verify", "--deep", "--strict", appBundlePath], {
    encoding: "utf8",
  });
  if (codesign.error) {
    throw codesign.error;
  }
  if (codesign.status !== 0) {
    throw new Error(codesign.stderr?.trim() || `codesign verification failed for ${appBundlePath}`);
  }

  const infoPlistPath = resolve(appBundlePath, "Contents/Info.plist");
  const executableName = execFileSync(
    "plutil",
    ["-extract", "CFBundleExecutable", "raw", infoPlistPath],
    { encoding: "utf8" },
  ).trim();
  const executablePath = resolve(appBundlePath, "Contents/MacOS", executableName);
  const lipoOutput = execFileSync("lipo", ["-archs", executablePath], { encoding: "utf8" }).trim();
  const actualArchs = new Set(lipoOutput.split(/\s+/).filter(Boolean));
  const expectedArchs = EXPECTED_MACHO_ARCHS[target] ?? [];
  const missingArchs = expectedArchs.filter((arch) => !actualArchs.has(arch));
  if (missingArchs.length > 0) {
    throw new Error(
      `Expected Mach-O slices [${expectedArchs.join(", ")}] in ${executablePath}, found [${[...actualArchs].join(", ")}].`,
    );
  }
}

function verifyMountedDmgAppBundle(dmgPath, productName, target) {
  const mountPoint = mkdtempSync(join(tmpdir(), "waypoint-dmg-verify-"));
  let attached = false;
  try {
    const attach = spawnSync(
      "hdiutil",
      ["attach", "-nobrowse", "-readonly", "-mountpoint", mountPoint, dmgPath],
      { encoding: "utf8" },
    );
    if (attach.error) {
      throw attach.error;
    }
    if (attach.status !== 0) {
      throw new Error(attach.stderr?.trim() || `hdiutil attach failed for ${dmgPath}`);
    }
    attached = true;
    verifyAppBundle(resolve(mountPoint, `${productName}.app`), target);
  } finally {
    if (attached) {
      const detach = spawnSync("hdiutil", ["detach", mountPoint, "-quiet"], { encoding: "utf8" });
      if (detach.status !== 0) {
        spawnSync("hdiutil", ["detach", mountPoint, "-force", "-quiet"], { encoding: "utf8" });
      }
    }
    rmSync(mountPoint, { recursive: true, force: true });
  }
}

function main() {
  let options;
  try {
    options = parseBuildArgs(process.argv.slice(2), { defaultTarget: "aarch64-apple-darwin" });
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
  const { plan, isShallow } = resolved;

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

  try {
    assertCommitCountSafe({
      isShallow,
      release: plan.release,
      label: "macOS CFBundleVersion",
    });

    console.log(
      `Building macOS DMG (${plan.target}, ${plan.signingMode}): version=${plan.version} (${plan.bundleVersion}), out=${plan.outputPath}`,
    );
    const buildStartMs = Date.now();
    runTauriCli(plan.tauriArgs);

    const tauriPrefix = `${plan.productName}_${plan.version}_`;
    const sourceDmg = findFreshArtifact(
      plan.dmgBundleDir,
      (name) => name.startsWith(tauriPrefix) && name.endsWith(".dmg"),
      buildStartMs,
      `${tauriPrefix}*.dmg`,
    );

    mkdirSync(dirname(plan.outputPath), { recursive: true });
    if (sourceDmg !== plan.outputPath) {
      copyFileSync(sourceDmg, plan.outputPath);
    }

    const verify = spawnSync("hdiutil", ["verify", plan.outputPath], {
      encoding: "utf8",
    });
    if (verify.error) {
      throw verify.error;
    }
    if (verify.status !== 0) {
      throw new Error(verify.stderr?.trim() || `hdiutil verify failed for ${plan.outputPath}`);
    }

    verifyMountedDmgAppBundle(plan.outputPath, plan.productName, plan.target);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  const sizeBytes = statSync(plan.outputPath).size;
  console.log("\n=== macOS DMG Ready ===");
  console.log(`Path: ${plan.outputPath}`);
  console.log(`Size: ${formatSizeMb(sizeBytes)} MB (${sizeBytes} bytes)`);
  console.log(`Target: ${plan.target}`);
  console.log(`Version: ${plan.version} (${plan.bundleVersion})`);
  console.log(`Signing: ${plan.signingMode}`);
}

main();
