import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ROOT_DIR } from "./build-common.mjs";

const STRICT_SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function parseStrictSemver(rawVersion, label = "version") {
  const normalized = String(rawVersion ?? "").trim().replace(/^v/i, "");
  const match = STRICT_SEMVER_RE.exec(normalized);
  if (!match) {
    throw new Error(
      `Invalid ${label} "${rawVersion}". Expected strict X.Y.Z semver without leading zeros.`,
    );
  }
  return {
    version: normalized,
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    patch: Number.parseInt(match[3], 10),
  };
}

export function compareSemver(a, b) {
  const pa = parseStrictSemver(a);
  const pb = parseStrictSemver(b);
  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  return pa.patch - pb.patch;
}

export function resolveNextVersion(currentVersion, targetInput) {
  const current = parseStrictSemver(currentVersion, "current version");
  const trimmed = String(targetInput ?? "").trim();
  if (!trimmed) {
    throw new Error("Missing target version or bump keyword (patch | minor | major | X.Y.Z).");
  }

  if (trimmed === "patch") {
    return `${current.major}.${current.minor}.${current.patch + 1}`;
  }
  if (trimmed === "minor") {
    return `${current.major}.${current.minor + 1}.0`;
  }
  if (trimmed === "major") {
    return `${current.major + 1}.0.0`;
  }

  const next = parseStrictSemver(trimmed, "target version");
  if (compareSemver(next.version, current.version) <= 0) {
    throw new Error(
      `Target version ${next.version} must be strictly greater than current version ${current.version}.`,
    );
  }
  return next.version;
}

export function getVersionFilePaths(rootDir = ROOT_DIR) {
  return {
    packageJsonPath: resolve(rootDir, "package.json"),
    packageLockPath: resolve(rootDir, "package-lock.json"),
    tauriConfPath: resolve(rootDir, "src-tauri/tauri.conf.json"),
    cargoTomlPath: resolve(rootDir, "src-tauri/Cargo.toml"),
    cargoLockPath: resolve(rootDir, "src-tauri/Cargo.lock"),
  };
}

function readCargoPackageVersion(cargoToml) {
  const pkgSection = cargoToml.match(/\[package\]([\s\S]*?)(?=\n\[|$)/)?.[1];
  if (!pkgSection) {
    throw new Error("Missing [package] section in src-tauri/Cargo.toml.");
  }
  const match = pkgSection.match(/^version\s*=\s*"([^"]+)"/m);
  if (!match) {
    throw new Error("Missing version field in [package] section of src-tauri/Cargo.toml.");
  }
  return match[1];
}

function replaceCargoPackageVersion(cargoToml, nextVersion) {
  let replaced = false;
  const updated = cargoToml.replace(
    /(\[package\][\s\S]*?^version\s*=\s*")([^"]+)(")/m,
    (_full, prefix, _oldVersion, suffix) => {
      replaced = true;
      return `${prefix}${nextVersion}${suffix}`;
    },
  );
  if (!replaced) {
    throw new Error("Failed to locate [package] version in src-tauri/Cargo.toml.");
  }
  return updated;
}

function readCargoLockPackageVersion(cargoLock, packageName = "waypoint") {
  const blocks = cargoLock.split(/\r?\n\r?\n/);
  for (const block of blocks) {
    if (!/^\[\[package\]\]/m.test(block)) continue;
    const nameMatch = block.match(/^name\s*=\s*"([^"]+)"/m);
    if (nameMatch?.[1] !== packageName) continue;
    const versionMatch = block.match(/^version\s*=\s*"([^"]+)"/m);
    if (!versionMatch) {
      throw new Error(`Missing version for [[package]] name = "${packageName}" in src-tauri/Cargo.lock.`);
    }
    return versionMatch[1];
  }
  throw new Error(`Missing [[package]] name = "${packageName}" in src-tauri/Cargo.lock.`);
}

function replaceCargoLockPackageVersion(cargoLock, nextVersion, packageName = "waypoint") {
  const eol = cargoLock.includes("\r\n") ? "\r\n" : "\n";
  const blocks = cargoLock.split(/\r?\n\r?\n/);
  let replaced = false;

  const updatedBlocks = blocks.map((block) => {
    if (!/^\[\[package\]\]/m.test(block)) return block;
    const nameMatch = block.match(/^name\s*=\s*"([^"]+)"/m);
    if (nameMatch?.[1] !== packageName) return block;
    const updatedBlock = block.replace(
      /^(version\s*=\s*")([^"]+)(")/m,
      (_full, prefix, _oldVersion, suffix) => {
        replaced = true;
        return `${prefix}${nextVersion}${suffix}`;
      },
    );
    return updatedBlock;
  });

  if (!replaced) {
    throw new Error(`Failed to update [[package]] name = "${packageName}" in src-tauri/Cargo.lock.`);
  }
  return updatedBlocks.join(`${eol}${eol}`);
}

export function readAllVersions(rootDir = ROOT_DIR) {
  const paths = getVersionFilePaths(rootDir);
  for (const [label, filePath] of Object.entries(paths)) {
    if (!existsSync(filePath)) {
      throw new Error(`Missing version file (${label}): ${filePath}`);
    }
  }

  const pkg = JSON.parse(readFileSync(paths.packageJsonPath, "utf8"));
  const pkgLock = JSON.parse(readFileSync(paths.packageLockPath, "utf8"));
  const tauriConf = JSON.parse(readFileSync(paths.tauriConfPath, "utf8"));
  const cargoToml = readFileSync(paths.cargoTomlPath, "utf8");
  const cargoLock = readFileSync(paths.cargoLockPath, "utf8");

  return {
    "package.json": pkg.version,
    "package-lock.json#version": pkgLock.version,
    'package-lock.json#packages[""].version': pkgLock.packages?.[""]?.version,
    "src-tauri/tauri.conf.json": tauriConf.version,
    "src-tauri/Cargo.toml": readCargoPackageVersion(cargoToml),
    "src-tauri/Cargo.lock": readCargoLockPackageVersion(cargoLock),
  };
}

export function assertConsistentVersions(rootDir = ROOT_DIR) {
  const versions = readAllVersions(rootDir);
  const entries = Object.entries(versions);
  const first = parseStrictSemver(entries[0][1], entries[0][0]).version;

  const mismatches = [];
  for (const [source, rawValue] of entries) {
    let parsed;
    try {
      parsed = parseStrictSemver(rawValue, source).version;
    } catch {
      mismatches.push(`${source}=${JSON.stringify(rawValue)}`);
      continue;
    }
    if (parsed !== first) {
      mismatches.push(`${source}=${parsed}`);
    }
  }

  if (mismatches.length > 0) {
    const summary = entries.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(", ");
    throw new Error(`Manifest/lockfile version mismatch: ${summary}`);
  }

  return first;
}

export function updateAllVersions(nextVersionRaw, rootDir = ROOT_DIR) {
  const nextVersion = parseStrictSemver(nextVersionRaw, "next version").version;
  const paths = getVersionFilePaths(rootDir);

  const pkg = JSON.parse(readFileSync(paths.packageJsonPath, "utf8"));
  pkg.version = nextVersion;
  writeFileSync(paths.packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");

  const pkgLock = JSON.parse(readFileSync(paths.packageLockPath, "utf8"));
  pkgLock.version = nextVersion;
  if (!pkgLock.packages || typeof pkgLock.packages[""] !== "object" || pkgLock.packages[""] === null) {
    throw new Error('Missing packages[""] entry in package-lock.json.');
  }
  pkgLock.packages[""].version = nextVersion;
  writeFileSync(paths.packageLockPath, `${JSON.stringify(pkgLock, null, 2)}\n`, "utf8");

  const tauriConf = JSON.parse(readFileSync(paths.tauriConfPath, "utf8"));
  tauriConf.version = nextVersion;
  writeFileSync(paths.tauriConfPath, `${JSON.stringify(tauriConf, null, 2)}\n`, "utf8");

  const cargoToml = readFileSync(paths.cargoTomlPath, "utf8");
  writeFileSync(paths.cargoTomlPath, replaceCargoPackageVersion(cargoToml, nextVersion), "utf8");

  const cargoLock = readFileSync(paths.cargoLockPath, "utf8");
  writeFileSync(
    paths.cargoLockPath,
    replaceCargoLockPackageVersion(cargoLock, nextVersion),
    "utf8",
  );

  return assertConsistentVersions(rootDir);
}
