// @ts-expect-error Node.js built-in fs in Vitest test runner
import { readdirSync, readFileSync } from "node:fs";
// @ts-expect-error Node.js built-in path in Vitest test runner
import { join, relative, resolve } from "node:path";
import { describe, expect, test } from "vitest";

const ROOT_DIR = (
  globalThis as unknown as { process: { cwd: () => string } }
).process.cwd();

function collectSourceFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectSourceFiles(fullPath));
    } else if (
      entry.isFile() &&
      (entry.name.endsWith(".tsx") || entry.name.endsWith(".ts")) &&
      !entry.name.endsWith(".d.ts") &&
      !entry.name.includes(".test.")
    ) {
      results.push(fullPath);
    }
  }
  return results;
}

describe("Theme & CSS architecture static guards (#90)", () => {
  test("all UI TS/TSX files contain zero raw hex color literals and zero non-semantic Tailwind palette classes", () => {
    const targets = [
      resolve(ROOT_DIR, "src/App.tsx"),
      ...collectSourceFiles(resolve(ROOT_DIR, "src/components")),
      ...collectSourceFiles(resolve(ROOT_DIR, "src/lib")),
      ...collectSourceFiles(resolve(ROOT_DIR, "src/waypoint")),
    ].sort();

    expect(targets.length).toBeGreaterThan(10);

    const hexPattern = /#[0-9a-fA-F]{3,8}\b/;
    const rawPalettePattern =
      /\b(?:bg|text|border|ring|fill|stroke)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-[0-9]{2,3}\b/;

    const hexViolations: string[] = [];
    const paletteViolations: string[] = [];

    for (const filePath of targets) {
      const rel = relative(ROOT_DIR, filePath);
      const source = readFileSync(filePath, "utf-8");
      const lines = source.split("\n");
      lines.forEach((line: string, index: number) => {
        if (hexPattern.test(line)) {
          hexViolations.push(`${rel}:${index + 1}: ${line.trim()}`);
        }
        if (rawPalettePattern.test(line)) {
          paletteViolations.push(`${rel}:${index + 1}: ${line.trim()}`);
        }
      });
    }

    expect(hexViolations).toEqual([]);
    expect(paletteViolations).toEqual([]);
  });

  test("src/App.css defines Grokbot Light/Dark tokens and strips retired legacy tokens, palettes, and component selectors", () => {
    const css = readFileSync(resolve(ROOT_DIR, "src/App.css"), "utf-8");

    expect(css).toContain('@import "tailwindcss";');
    expect(css).toContain("@theme inline");
    expect(css).toContain("@custom-variant dark");
    expect(css).toContain("@media (prefers-color-scheme: dark)");
    expect(css).toContain(':root:not(.light):not([data-theme="light"])');
    expect(css).toContain(".dark,");
    expect(css).toContain('[data-theme="dark"]');

    const requiredTokens = [
      "--background",
      "--foreground",
      "--card",
      "--card-foreground",
      "--popover",
      "--popover-foreground",
      "--primary",
      "--primary-foreground",
      "--secondary",
      "--secondary-foreground",
      "--muted",
      "--muted-foreground",
      "--accent",
      "--accent-foreground",
      "--destructive",
      "--destructive-foreground",
      "--border",
      "--input",
      "--ring",
      "--warning",
      "--warning-foreground",
      "--warning-border",
      "--grok-dark-background",
      "--grok-dark-foreground",
      "--grok-dark-primary",
    ];
    for (const token of requiredTokens) {
      expect(css, `src/App.css should define ${token}`).toContain(`${token}:`);
    }

    // Zero retired legacy token declarations
    const retiredTokens = [
      "--bg:",
      "--bg-subtle:",
      "--sidebar:",
      "--sidebar-border:",
      "--header:",
      "--card-subtle:",
      "--ink:",
      "--ink-secondary:",
      "--legacy-muted:",
      "--line:",
      "--line-subtle:",
      "--legacy-accent:",
      "--accent-hover:",
      "--accent-ink:",
      "--accent-subtle:",
      "--accent-text:",
      "--text-main:",
      "--owner-bg:",
      "--owner-ink:",
      "--code-bg:",
      "--code-header-bg:",
      "--code-body-bg:",
      "--danger:",
      "--danger-bg:",
      "--danger-border:",
      "--warn-bg:",
      "--warn-ink:",
      "--warn-border:",
      "--pinned-accent:",
      "--modal-backdrop:",
      "--modal-bg:",
    ];
    for (const token of retiredTokens) {
      expect(css, `retired token ${token} must not remain in src/App.css`).not.toContain(token);
    }

    // Zero retired component CSS selectors
    const retiredSelectors = [
      ".waypoint-auth-card",
      ".waypoint-auth-main",
      ".waypoint-auth-form",
      ".waypoint-settings-header",
      ".waypoint-settings-backdrop",
      ".waypoint-agents-header",
      ".waypoint-bot-list",
      ".waypoint-bubble-wrapper",
      ".waypoint-bubble",
      ".waypoint-composer-form",
      ".waypoint-composer-card",
      ".waypoint-composer-safe-area",
      ".waypoint-create-topic-btn",
      ".waypoint-topic-row",
      ".waypoint-sidebar-icon-btn",
      ".waypoint-empty-card",
      ".waypoint-modal-backdrop",
      ".waypoint-dialog",
      ".waypoint-toast",
      ".waypoint-reauth-banner",
      ".waypoint-unavailable-banner",
    ];
    for (const selector of retiredSelectors) {
      const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const selectorPattern = new RegExp(`${escaped}(?![a-z0-9-])`);
      expect(css, `retired selector ${selector} must not remain in src/App.css`).not.toMatch(
        selectorPattern,
      );
    }

    // Zero retired warm-paper / night-blue / bright-blue hex palette colors
    const retiredHexColors = [
      "#faf7f2",
      "#f2ece1",
      "#0f172a",
      "#0c1322",
      "#182236",
      "#2563eb",
      "#3b82f6",
      "#1d4ed8",
      "#60a5fa",
      "#16181d",
      "#1e222a",
      "#eaedf1",
    ];
    const lowerCss = css.toLowerCase();
    for (const hex of retiredHexColors) {
      expect(lowerCss, `retired hex ${hex} must not remain in src/App.css`).not.toContain(hex);
    }

    // Zero stray hex literals outside :root { ... } token definitions
    const lines = css.split("\n");
    let insideRootTokens = false;
    const strayHexLines: string[] = [];
    for (const line of lines) {
      if (line.trim() === ":root {") {
        insideRootTokens = true;
      }
      if (insideRootTokens && line.trim() === "}") {
        insideRootTokens = false;
      }
      if (!insideRootTokens && /#[0-9a-fA-F]{3,8}\b/.test(line)) {
        strayHexLines.push(line.trim());
      }
    }
    expect(strayHexLines).toEqual([]);
  });
});
