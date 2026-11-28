#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { readNextFlagValue, ROOT_DIR } from "./lib/build-common.mjs";
import { assertConsistentVersions, parseStrictSemver } from "./lib/release-version.mjs";

function printHelp() {
  console.log(`Tag main and trigger the Waypoint Release workflow

Usage:
  node scripts/tag-release.mjs [options]

Options:
  --version <X.Y.Z>    Assert manifest version equals X.Y.Z before tagging
  --skip-ci-check      Skip checking whether CI workflow passed on main HEAD
  --dry-run            Validate preconditions and print tag plan JSON without creating/pushing tag
  -h, --help           Show this help message`);
}

function parseArgs(argv) {
  const options = {
    expectedVersion: undefined,
    skipCiCheck: false,
    dryRun: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      options.help = true;
    } else if (arg === "--skip-ci-check") {
      options.skipCiCheck = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--version") {
      options.expectedVersion = parseStrictSemver(
        readNextFlagValue(argv, i, "--version"),
        "--version",
      ).version;
      i += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function runGit(args, { stdio = ["ignore", "pipe", "pipe"] } = {}) {
  return (execFileSync("git", args, {
    cwd: ROOT_DIR,
    encoding: "utf8",
    stdio,
  }) ?? "").trim();
}

function assertGitPreconditions({ tag, skipCiCheck }) {
  const dirty = runGit(["status", "--porcelain"]);
  if (dirty) {
    throw new Error("Working tree is not clean. Commit or stash changes before tagging a release.");
  }

  const currentBranch = runGit(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (currentBranch !== "main") {
    throw new Error(`Release tags must be created from "main", got "${currentBranch}".`);
  }

  runGit(["fetch", "origin", "main"], { stdio: "inherit" });
  const localHead = runGit(["rev-parse", "HEAD"]);
  const remoteHead = runGit(["rev-parse", "origin/main"]);
  if (localHead !== remoteHead) {
    throw new Error(
      `Local main (${localHead.slice(0, 7)}) is not at origin/main (${remoteHead.slice(0, 7)}). Sync main before tagging.`,
    );
  }

  const localTagExists = spawnSync("git", ["show-ref", "--verify", "--quiet", `refs/tags/${tag}`], {
    cwd: ROOT_DIR,
  });
  if (localTagExists.status === 0) {
    throw new Error(`Tag "${tag}" already exists locally.`);
  }

  const remoteTag = runGit(["ls-remote", "--tags", "origin", `refs/tags/${tag}`]);
  if (remoteTag) {
    throw new Error(`Tag "${tag}" already exists on origin.`);
  }

  let ciRunUrl = null;
  if (!skipCiCheck) {
    const ghAuth = spawnSync("gh", ["auth", "status"], {
      cwd: ROOT_DIR,
      encoding: "utf8",
    });
    if (ghAuth.error || ghAuth.status !== 0) {
      throw new Error(
        `GitHub CLI authentication is required to verify CI on HEAD (or pass --skip-ci-check): ${ghAuth.stderr?.trim() || ghAuth.error?.message || "gh auth status failed"}`,
      );
    }

    const rawRuns = execFileSync(
      "gh",
      [
        "run",
        "list",
        "--workflow",
        "ci.yml",
        "--commit",
        localHead,
        "--json",
        "databaseId,status,conclusion,url,event,createdAt",
        "--limit",
        "20",
      ],
      { cwd: ROOT_DIR, encoding: "utf8" },
    );
    const runs = JSON.parse(rawRuns);
    const passingRun = runs.find(
      (run) => run.status === "completed" && run.conclusion === "success",
    );
    if (!passingRun) {
      const latest = runs[0];
      const detail = latest
        ? `latest CI run status=${latest.status}, conclusion=${latest.conclusion ?? "pending"} (${latest.url})`
        : `no CI workflow runs found for commit ${localHead.slice(0, 7)}`;
      throw new Error(
        `CI has not passed on main HEAD (${localHead.slice(0, 7)}): ${detail}. Wait for CI or pass --skip-ci-check.`,
      );
    }
    ciRunUrl = passingRun.url;
  }

  return { headSha: localHead, ciRunUrl };
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

  try {
    const version = assertConsistentVersions();
    if (options.expectedVersion && options.expectedVersion !== version) {
      throw new Error(
        `Expected version ${options.expectedVersion}, but manifests/lockfiles are at ${version}.`,
      );
    }
    const tag = `v${version}`;
    const { headSha, ciRunUrl } = assertGitPreconditions({
      tag,
      skipCiCheck: options.skipCiCheck,
    });

    const plan = {
      version,
      tag,
      headSha,
      ciRunUrl,
      skipCiCheck: options.skipCiCheck,
    };

    if (options.dryRun) {
      console.log(JSON.stringify(plan, null, 2));
      return;
    }

    console.log(`Creating annotated tag ${tag} at ${headSha.slice(0, 7)}...`);
    runGit(["tag", "-a", tag, "-m", `Release ${tag}`], { stdio: "inherit" });
    console.log(`Pushing ${tag} to origin...`);
    runGit(["push", "origin", `refs/tags/${tag}`], { stdio: "inherit" });

    console.log("\n=== Release Tag Pushed ===");
    console.log(`Tag: ${tag}`);
    console.log(`Commit: ${headSha}`);
    if (ciRunUrl) {
      console.log(`Verified CI: ${ciRunUrl}`);
    }
    console.log("GitHub Actions Release workflow should now start automatically.");
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

main();
