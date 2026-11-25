import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const LIB_DIR = dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = resolve(LIB_DIR, "../..");
export const TAURI_CONF_PATH = resolve(ROOT_DIR, "src-tauri/tauri.conf.json");
export const TAURI_CLI_BIN = resolve(ROOT_DIR, "node_modules/@tauri-apps/cli/tauri.js");

export function readNextFlagValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith("-")) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

export function parseBuildArgs(
  argv,
  { defaultTarget, allowTarget = true, allowUnsigned = false } = {},
) {
  const options = {
    targetRaw: defaultTarget,
    outPath: undefined,
    outDir: undefined,
    release: false,
    unsigned: false,
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
    } else if (allowUnsigned && arg === "--unsigned") {
      options.unsigned = true;
    } else if (allowTarget && arg === "--target") {
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

export function normalizeSemver(rawVersion, label, detail) {
  const stripped = rawVersion.trim().replace(/^v/i, "");
  if (!/^\d+\.\d+\.\d+$/.test(stripped)) {
    throw new Error(`Invalid ${label} version "${rawVersion}". ${detail}`);
  }
  return stripped;
}

export function readTauriConf() {
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

export function readGitInfo({ needCommitCount = false } = {}) {
  const shortSha = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
    cwd: ROOT_DIR,
    encoding: "utf8",
  }).trim();
  if (!needCommitCount) {
    return { shortSha, commitCount: undefined, isShallow: false };
  }
  const isShallow =
    execFileSync("git", ["rev-parse", "--is-shallow-repository"], {
      cwd: ROOT_DIR,
      encoding: "utf8",
    }).trim() === "true";
  const commitCount = Number.parseInt(
    execFileSync("git", ["rev-list", "--count", "HEAD"], {
      cwd: ROOT_DIR,
      encoding: "utf8",
    }).trim(),
    10,
  );
  return { shortSha, commitCount, isShallow };
}

export function assertCommitCountSafe({ isShallow, release, label }) {
  if (!isShallow) return;
  if (release) {
    throw new Error(
      `Refusing to derive ${label} from git rev-list --count in a shallow clone. Re-run with full git history (fetch-depth: 0).`,
    );
  }
  console.warn(
    `Warning: shallow git clone detected; derived ${label} from git rev-list --count may be lower than full history.`,
  );
}

export function resolveCargoTargetDir() {
  const raw = process.env.CARGO_TARGET_DIR?.trim();
  return raw ? resolve(ROOT_DIR, raw) : resolve(ROOT_DIR, "src-tauri/target");
}

export function resolveOutputPath({ outPath, outDir, defaultDir, filename }) {
  if (outPath && outDir) {
    throw new Error("Cannot specify both --out and --out-dir.");
  }
  if (outPath) {
    return resolve(ROOT_DIR, outPath);
  }
  if (outDir) {
    return resolve(ROOT_DIR, outDir, filename);
  }
  return resolve(defaultDir, filename);
}

export function findFreshArtifact(dir, predicate, buildStartMs, description) {
  if (!existsSync(dir)) {
    throw new Error(`Expected bundle directory not found: ${dir}`);
  }
  const candidates = readdirSync(dir)
    .filter((name) => predicate(name))
    .map((name) => {
      const fullPath = resolve(dir, name);
      return { fullPath, mtimeMs: statSync(fullPath).mtimeMs };
    })
    .filter((entry) => entry.mtimeMs >= buildStartMs - 1000)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  if (candidates.length === 0) {
    throw new Error(`No freshly generated ${description} found in ${dir}`);
  }
  return candidates[0].fullPath;
}

export function runTauriCli(tauriArgs, env = process.env) {
  if (!existsSync(TAURI_CLI_BIN)) {
    throw new Error(`Tauri CLI entrypoint not found at ${TAURI_CLI_BIN}. Run npm ci first.`);
  }
  const build = spawnSync(process.execPath, [TAURI_CLI_BIN, ...tauriArgs], {
    cwd: ROOT_DIR,
    env,
    stdio: "inherit",
  });
  if (build.error) {
    throw build.error;
  }
  if (build.status !== 0) {
    process.exit(build.status ?? 1);
  }
}

export function compareVersionDesc(a, b) {
  const pa = a.split(/[^0-9]+/).filter(Boolean).map((n) => Number.parseInt(n, 10));
  const pb = b.split(/[^0-9]+/).filter(Boolean).map((n) => Number.parseInt(n, 10));
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va !== vb) return vb - va;
  }
  return b.localeCompare(a);
}

export function formatSizeMb(sizeBytes) {
  return (sizeBytes / (1024 * 1024)).toFixed(2);
}
