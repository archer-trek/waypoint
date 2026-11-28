#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { readNextFlagValue, ROOT_DIR } from "./lib/build-common.mjs";
import { assertConsistentVersions, resolveNextVersion } from "./lib/release-version.mjs";

const VERSION_FILES = [
  "package.json",
  "package-lock.json",
  "src-tauri/tauri.conf.json",
  "src-tauri/Cargo.toml",
  "src-tauri/Cargo.lock",
];

function printHelp() {
  console.log(`Prepare a Waypoint release PR branch

Usage:
  node scripts/prepare-release.mjs <patch|minor|major|X.Y.Z> [options]
  node scripts/prepare-release.mjs --version <patch|minor|major|X.Y.Z> [options]

Options:
  --version <bump|X.Y.Z>   Target version or bump keyword (patch | minor | major | X.Y.Z)
  --pr                     Push branch to origin and open a GitHub PR targeting main
  --skip-checks            Skip npm run lint, typecheck, and test:unit
  --dry-run                Print resolved release plan JSON without modifying files or git
  -h, --help               Show this help message`);
}

function parseArgs(argv) {
  const options = {
    targetInput: undefined,
    pr: false,
    skipChecks: false,
    dryRun: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      options.help = true;
    } else if (arg === "--pr") {
      options.pr = true;
    } else if (arg === "--skip-checks") {
      options.skipChecks = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--version") {
      if (options.targetInput) {
        throw new Error("Target version specified more than once.");
      }
      options.targetInput = readNextFlagValue(argv, i, "--version");
      i += 1;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown argument: ${arg}`);
    } else {
      if (options.targetInput) {
        throw new Error(`Unexpected positional argument "${arg}" (version already set to "${options.targetInput}").`);
      }
      options.targetInput = arg;
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

function runNpmScript(scriptName) {
  const npmBin = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(npmBin, ["run", scriptName], {
    cwd: ROOT_DIR,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`npm run ${scriptName} failed with exit code ${result.status ?? 1}.`);
  }
}

function assertCleanMainAndPreflight({ branch, tag, pr }) {
  const dirty = runGit(["status", "--porcelain"]);
  if (dirty) {
    throw new Error("Working tree is not clean. Commit or stash changes before preparing a release.");
  }

  const currentBranch = runGit(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (currentBranch !== "main") {
    throw new Error(`Expected current branch to be "main", got "${currentBranch}".`);
  }

  runGit(["fetch", "origin", "main"], { stdio: "inherit" });
  const localHead = runGit(["rev-parse", "HEAD"]);
  const remoteHead = runGit(["rev-parse", "origin/main"]);
  if (localHead !== remoteHead) {
    throw new Error(
      `Local main (${localHead.slice(0, 7)}) is not at origin/main (${remoteHead.slice(0, 7)}). Sync main first.`,
    );
  }

  const localBranchExists = spawnSync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
    cwd: ROOT_DIR,
  });
  if (localBranchExists.status === 0) {
    throw new Error(`Release branch "${branch}" already exists locally.`);
  }

  const remoteBranch = runGit(["ls-remote", "--heads", "origin", branch]);
  if (remoteBranch) {
    throw new Error(`Release branch "${branch}" already exists on origin.`);
  }

  const localTagExists = spawnSync("git", ["show-ref", "--verify", "--quiet", `refs/tags/${tag}`], {
    cwd: ROOT_DIR,
  });
  if (localTagExists.status === 0) {
    throw new Error(`Release tag "${tag}" already exists locally.`);
  }

  const remoteTag = runGit(["ls-remote", "--tags", "origin", `refs/tags/${tag}`]);
  if (remoteTag) {
    throw new Error(`Release tag "${tag}" already exists on origin.`);
  }

  if (pr) {
    const ghAuth = spawnSync("gh", ["auth", "status"], {
      cwd: ROOT_DIR,
      encoding: "utf8",
    });
    if (ghAuth.error || ghAuth.status !== 0) {
      throw new Error(
        `GitHub CLI authentication is required for --pr: ${ghAuth.stderr?.trim() || ghAuth.error?.message || "gh auth status failed"}`,
      );
    }
  }
}

async function main() {
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
    const currentVersion = assertConsistentVersions();
    const nextVersion = resolveNextVersion(currentVersion, options.targetInput);
    const tag = `v${nextVersion}`;
    const branch = `chore/release-${tag}`;
    const commitMessage = `chore(release): prepare ${tag}`;
    plan = {
      currentVersion,
      nextVersion,
      tag,
      branch,
      commitMessage,
      files: VERSION_FILES,
      checks: options.skipChecks ? [] : ["lint", "typecheck", "test:unit"],
      openPr: options.pr,
    };
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  if (options.dryRun) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }

  const { updateAllVersions } = await import("./lib/release-version.mjs");

  try {
    assertCleanMainAndPreflight({ branch: plan.branch, tag: plan.tag, pr: plan.openPr });

    console.log(`Creating release branch ${plan.branch} from origin/main...`);
    runGit(["checkout", "-b", plan.branch, "origin/main"], { stdio: "inherit" });

    console.log(`Updating version from ${plan.currentVersion} to ${plan.nextVersion}...`);
    updateAllVersions(plan.nextVersion);

    if (!options.skipChecks) {
      for (const script of plan.checks) {
        console.log(`Running npm run ${script}...`);
        runNpmScript(script);
      }
    }

    runGit(["add", ...VERSION_FILES], { stdio: "inherit" });
    runGit(["commit", "-m", plan.commitMessage], { stdio: "inherit" });

    if (plan.openPr) {
      console.log(`Pushing ${plan.branch} and creating PR...`);
      runGit(["push", "-u", "origin", plan.branch], { stdio: "inherit" });

      const prBody = [
        `## Release ${plan.tag}`,
        "",
        `Bumps Waypoint from \`${plan.currentVersion}\` to \`${plan.nextVersion}\` across all manifest and lockfiles:`,
        ...VERSION_FILES.map((file) => `- \`${file}\``),
        "",
        "### Next steps after merge",
        "1. Wait for `CI` checks on `main` to pass.",
        `2. Run \`npm run release:tag\` (or \`make release-tag\`) on \`main\` to push \`${plan.tag}\` and trigger the multi-platform \`Release\` workflow.`,
      ].join("\n");

      const prUrl = execFileSync(
        "gh",
        [
          "pr",
          "create",
          "--base",
          "main",
          "--head",
          plan.branch,
          "--title",
          plan.commitMessage,
          "--body",
          prBody,
        ],
        { cwd: ROOT_DIR, encoding: "utf8" },
      ).trim();
      console.log(`\nRelease PR created: ${prUrl}`);
    } else {
      console.log("\n=== Release Branch Ready ===");
      console.log(`Branch: ${plan.branch}`);
      console.log(`Version: ${plan.currentVersion} -> ${plan.nextVersion}`);
      console.log("Next steps:");
      console.log(`  git push -u origin ${plan.branch}`);
      console.log(`  gh pr create --base main --head ${plan.branch} --title "${plan.commitMessage}"`);
      console.log("After the PR is squash-merged into main, run: npm run release:tag");
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

main();
