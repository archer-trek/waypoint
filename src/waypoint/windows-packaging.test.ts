import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const NODE_PROCESS = (
  globalThis as unknown as {
    process: { cwd: () => string; platform: string; env: Record<string, string | undefined> };
  }
).process;
const ROOT_DIR = NODE_PROCESS.cwd();
const HOST_PLATFORM = NODE_PROCESS.platform;
const SCRIPT_PATH = resolve(ROOT_DIR, "scripts/build-windows-installer.mjs");

const SIGNING_ENV_KEYS = [
  "WINDOWS_SIGN_COMMAND",
  "WINDOWS_CERTIFICATE_THUMBPRINT",
  "WINDOWS_TIMESTAMP_URL",
  "WINDOWS_DIGEST_ALGORITHM",
  "WINDOWS_TSP",
] as const;

function runBuildScript(args: string[], extraEnv: Record<string, string | undefined> = {}) {
  const env: Record<string, string | undefined> = { ...NODE_PROCESS.env };
  for (const key of SIGNING_ENV_KEYS) {
    delete env[key];
  }
  for (const [key, value] of Object.entries(extraEnv)) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }
  return spawnSync("node", [SCRIPT_PATH, ...args], {
    cwd: ROOT_DIR,
    env,
    encoding: "utf8",
  }) as { status: number | null; stdout: string; stderr: string };
}

describe("build-windows-installer CLI", () => {
  test("resolves default x64 unsigned test NSIS plan in --dry-run mode", () => {
    const tauriConf = JSON.parse(
      readFileSync(resolve(ROOT_DIR, "src-tauri/tauri.conf.json"), "utf8"),
    ) as { version: string; productName: string };

    const res = runBuildScript(["--dry-run"]);
    expect(res.status, res.stderr).toBe(0);

    const plan = JSON.parse(res.stdout) as {
      target: string;
      archLabel: string;
      version: string;
      release: boolean;
      signingMode: string;
      installerFilename: string;
      outputPath: string;
      tauriArgs: string[];
    };

    expect(plan.target).toBe("x86_64-pc-windows-msvc");
    expect(plan.archLabel).toBe("x64");
    expect(plan.version).toBe(tauriConf.version);
    expect(plan.release).toBe(false);
    expect(plan.signingMode).toBe("unsigned");
    expect(plan.installerFilename).toMatch(
      new RegExp(`^${tauriConf.productName}-${tauriConf.version}-test\\.[0-9a-f]+-x64-setup\\.exe$`),
    );
    expect(plan.outputPath).toBe(
      resolve(ROOT_DIR, "src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis", plan.installerFilename),
    );
    expect(plan.tauriArgs).toContain("build");
    expect(plan.tauriArgs).toContain("--target");
    expect(plan.tauriArgs).toContain("x86_64-pc-windows-msvc");
    expect(plan.tauriArgs).toContain("--bundles");
    expect(plan.tauriArgs).toContain("nsis");
    expect(plan.tauriArgs).toContain("--ci");

    const configIndex = plan.tauriArgs.indexOf("--config");
    expect(configIndex).toBeGreaterThan(-1);
    const mergedConfig = JSON.parse(plan.tauriArgs[configIndex + 1]!) as {
      version: string;
      bundle?: { windows?: { signCommand?: string; certificateThumbprint?: string } };
    };
    expect(mergedConfig.version).toBe(tauriConf.version);
    expect(mergedConfig.bundle?.windows?.signCommand).toBeUndefined();
    expect(mergedConfig.bundle?.windows?.certificateThumbprint).toBeUndefined();
  });

  test("resolves release naming, arm64 alias, --version, and --out-dir", () => {
    const res = runBuildScript([
      "--dry-run",
      "--target",
      "arm64",
      "--release",
      "--version",
      "v0.2.0",
      "--out-dir",
      "artifacts/windows",
    ]);
    expect(res.status, res.stderr).toBe(0);

    const plan = JSON.parse(res.stdout) as {
      target: string;
      archLabel: string;
      version: string;
      release: boolean;
      installerFilename: string;
      outputPath: string;
    };

    expect(plan.target).toBe("aarch64-pc-windows-msvc");
    expect(plan.archLabel).toBe("arm64");
    expect(plan.version).toBe("0.2.0");
    expect(plan.release).toBe(true);
    expect(plan.installerFilename).toBe("Waypoint-0.2.0-arm64-setup.exe");
    expect(plan.outputPath).toBe(
      resolve(ROOT_DIR, "artifacts/windows/Waypoint-0.2.0-arm64-setup.exe"),
    );
  });

  test("supports explicit --out path and custom-command / thumbprint signing hooks", () => {
    const customCmdRes = runBuildScript(
      ["--dry-run", "--out", "tmp/custom-setup.exe"],
      {
        WINDOWS_SIGN_COMMAND: "signtool sign /fd SHA256 %1",
        WINDOWS_CERTIFICATE_THUMBPRINT: "IGNORED_WHEN_SIGN_COMMAND_IS_SET",
      },
    );
    expect(customCmdRes.status, customCmdRes.stderr).toBe(0);

    const customPlan = JSON.parse(customCmdRes.stdout) as {
      signingMode: string;
      outputPath: string;
      tauriArgs: string[];
    };
    expect(customPlan.signingMode).toBe("custom-command");
    expect(customPlan.outputPath).toBe(resolve(ROOT_DIR, "tmp/custom-setup.exe"));

    const customCfgIndex = customPlan.tauriArgs.indexOf("--config");
    const customCfg = JSON.parse(customPlan.tauriArgs[customCfgIndex + 1]!) as {
      bundle?: { windows?: { signCommand?: string; certificateThumbprint?: string } };
    };
    expect(customCfg.bundle?.windows?.signCommand).toBe("signtool sign /fd SHA256 %1");
    expect(customCfg.bundle?.windows?.certificateThumbprint).toBeUndefined();

    const thumbprintRes = runBuildScript(["--dry-run"], {
      WINDOWS_CERTIFICATE_THUMBPRINT: "ABCDEF1234567890",
      WINDOWS_TIMESTAMP_URL: "http://timestamp.digicert.com",
      WINDOWS_TSP: "true",
    });
    expect(thumbprintRes.status, thumbprintRes.stderr).toBe(0);

    const thumbprintPlan = JSON.parse(thumbprintRes.stdout) as {
      signingMode: string;
      tauriArgs: string[];
    };
    expect(thumbprintPlan.signingMode).toBe("thumbprint");
    const tpCfgIndex = thumbprintPlan.tauriArgs.indexOf("--config");
    const tpCfg = JSON.parse(thumbprintPlan.tauriArgs[tpCfgIndex + 1]!) as {
      bundle?: {
        windows?: {
          certificateThumbprint?: string;
          digestAlgorithm?: string;
          timestampUrl?: string;
          tsp?: boolean;
        };
      };
    };
    expect(tpCfg.bundle?.windows?.certificateThumbprint).toBe("ABCDEF1234567890");
    expect(tpCfg.bundle?.windows?.digestAlgorithm).toBe("sha256");
    expect(tpCfg.bundle?.windows?.timestampUrl).toBe("http://timestamp.digicert.com");
    expect(tpCfg.bundle?.windows?.tsp).toBe(true);
  });

  test("rejects unsupported target, non-semver version, --out + --out-dir conflict, and WINDOWS_SIGN_COMMAND missing %1, and honors CARGO_TARGET_DIR", () => {
    const badTarget = runBuildScript(["--dry-run", "--target", "armv7-pc-windows-msvc"]);
    expect(badTarget.status).not.toBe(0);
    expect(badTarget.stderr).toContain("Unsupported Windows target");

    const unsupportedBuildNumber = runBuildScript(["--dry-run", "--build-number", "12345"]);
    expect(unsupportedBuildNumber.status).not.toBe(0);
    expect(unsupportedBuildNumber.stderr).toContain("Unknown argument");

    const badVersion = runBuildScript(["--dry-run", "--version", "0.1.0-test.123"]);
    expect(badVersion.status).not.toBe(0);
    expect(badVersion.stderr).toContain("Invalid Windows version");

    const bothOut = runBuildScript(["--dry-run", "--out", "a.exe", "--out-dir", "artifacts"]);
    expect(bothOut.status).not.toBe(0);
    expect(bothOut.stderr).toContain("Cannot specify both --out and --out-dir");

    const badSignCmd = runBuildScript(["--dry-run"], {
      WINDOWS_SIGN_COMMAND: "signtool sign /fd SHA256",
    });
    expect(badSignCmd.status).not.toBe(0);
    expect(badSignCmd.stderr).toContain("%1");

    const customTargetRes = runBuildScript(["--dry-run"], {
      CARGO_TARGET_DIR: "tmp/cargo-target",
    });
    expect(customTargetRes.status, customTargetRes.stderr).toBe(0);
    const customTargetPlan = JSON.parse(customTargetRes.stdout) as {
      nsisBundleDir: string;
      installerFilename: string;
      outputPath: string;
    };
    expect(customTargetPlan.nsisBundleDir).toBe(
      resolve(ROOT_DIR, "tmp/cargo-target/x86_64-pc-windows-msvc/release/bundle/nsis"),
    );
    expect(customTargetPlan.outputPath).toBe(
      resolve(customTargetPlan.nsisBundleDir, customTargetPlan.installerFilename),
    );
  });

  if (HOST_PLATFORM !== "win32") {
    test("fails fast on non-Windows hosts when not in --dry-run mode", () => {
      const res = runBuildScript([]);
      expect(res.status).not.toBe(0);
      expect(res.stderr).toContain("win32");
    });
  }
});

describe("Windows packaging config, entrypoints, and workflows", () => {
  test("tauri.conf.json configures Windows NSIS currentUser, downloadBootstrapper, and icon.ico", () => {
    const tauriConf = JSON.parse(
      readFileSync(resolve(ROOT_DIR, "src-tauri/tauri.conf.json"), "utf8"),
    ) as {
      bundle?: {
        icon?: string[];
        windows?: {
          allowDowngrades?: boolean;
          minimumWebview2Version?: string;
          webviewInstallMode?: { type?: string; silent?: boolean };
          nsis?: {
            installMode?: string;
            languages?: string[];
            displayLanguageSelector?: boolean;
            installerIcon?: string;
          };
        };
      };
    };

    const win = tauriConf.bundle?.windows;
    expect(win?.webviewInstallMode).toEqual({ type: "downloadBootstrapper", silent: true });
    expect(win?.allowDowngrades).toBe(true);
    expect(win?.minimumWebview2Version).toBeUndefined();
    expect(win?.nsis?.installMode).toBe("currentUser");
    expect(win?.nsis?.languages).toEqual(["SimpChinese", "English"]);
    expect(win?.nsis?.displayLanguageSelector).toBe(false);
    expect(win?.nsis?.installerIcon).toBe("icons/icon.ico");
    expect(tauriConf.bundle?.icon).toContain("icons/icon.ico");
  });

  test("Makefile, package.json, .gitignore, and AGENTS.md expose Windows installer build entrypoints", () => {
    const makefile = readFileSync(resolve(ROOT_DIR, "Makefile"), "utf8");
    expect(makefile).toContain("build-windows-installer");
    expect(makefile).toContain("win: build-windows-installer");
    expect(makefile).toContain("scripts/build-windows-installer.mjs");

    const pkg = JSON.parse(readFileSync(resolve(ROOT_DIR, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    expect(pkg.scripts?.["build:windows"]).toBe("node scripts/build-windows-installer.mjs");

    const gitignore = readFileSync(resolve(ROOT_DIR, ".gitignore"), "utf8");
    expect(gitignore).toContain("*.exe");

    const agentsMd = readFileSync(resolve(ROOT_DIR, "AGENTS.md"), "utf8");
    expect(agentsMd).toContain("make build-windows-installer");
    expect(agentsMd).toContain("scripts/build-windows-installer.mjs");
  });

  test("ci.yml runs windows-build on windows-latest gated by native-filter and uploads NSIS artifact", () => {
    const ciYml = readFileSync(resolve(ROOT_DIR, ".github/workflows/ci.yml"), "utf8");
    expect(ciYml).toContain("windows-build:");
    expect(ciYml).toContain("if: needs.native-filter.outputs.run_windows == 'true'");
    expect(ciYml).toContain("runs-on: windows-latest");
    expect(ciYml).toContain("targets: x86_64-pc-windows-msvc");
    expect(ciYml).toContain("cargo clippy --all-targets -- -D warnings");
    expect(ciYml).toContain("node scripts/build-windows-installer.mjs");
    const windowsBuildSection = ciYml.split("\n  windows-build:")[1] ?? "";
    expect(windowsBuildSection).toContain("archive: false");
    expect(windowsBuildSection).not.toContain("waypoint-windows-nsis");
    expect(ciYml).toContain("artifacts/windows/*.exe");
  });

  test("release.yml unifies macOS and Windows release builds into one atomic Draft release", () => {
    expect(existsSync(resolve(ROOT_DIR, ".github/workflows/release-macos.yml"))).toBe(false);

    const releaseYml = readFileSync(resolve(ROOT_DIR, ".github/workflows/release.yml"), "utf8");
    expect(releaseYml).toContain("tags:");
    expect(releaseYml).toContain('"v*"');
    expect(releaseYml).toContain("workflow_dispatch:");
    expect(releaseYml).toContain("cancel-in-progress: false");
    expect(releaseYml).toContain("contents: write");
    expect(releaseYml).toContain("verify:");
    expect(releaseYml).toContain("runs-on: macos-latest");
    expect(releaseYml).toContain("windows-latest");
    expect(releaseYml).toContain("windows-11-arm");
    expect(releaseYml).toContain("x86_64-pc-windows-msvc");
    expect(releaseYml).toContain("aarch64-pc-windows-msvc");
    expect(releaseYml).toContain("scripts/build-windows-installer.mjs");
    expect(releaseYml).toContain("scripts/build-macos-dmg.mjs");
    expect(releaseYml).toContain("--release");
    expect(releaseYml).toContain("SHA256SUMS.txt");
    expect(releaseYml).toContain("isDraft");
    expect(releaseYml).toContain("gh release create");
    expect(releaseYml).toContain("--draft");
    expect(releaseYml.match(/archive: false/g)?.length).toBeGreaterThanOrEqual(2);
  });
});
