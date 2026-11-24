import { readdirSync, readFileSync } from "node:fs";
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

  test("UI TS/TSX files do not combine leading-none with truncate or overflow-hidden", () => {
    const targets = [
      resolve(ROOT_DIR, "src/App.tsx"),
      ...collectSourceFiles(resolve(ROOT_DIR, "src/components")),
      ...collectSourceFiles(resolve(ROOT_DIR, "src/waypoint")),
    ].sort();

    const violations: string[] = [];
    const leadingNoneRe = /\bleading-none\b/;
    const clipRe = /\b(?:truncate|overflow-hidden)\b/;

    for (const filePath of targets) {
      const rel = relative(ROOT_DIR, filePath);
      const source = readFileSync(filePath, "utf-8");
      const lines = source.split("\n");
      lines.forEach((line: string, index: number) => {
        if (leadingNoneRe.test(line) && clipRe.test(line)) {
          violations.push(`${rel}:${index + 1}: ${line.trim()}`);
        }
      });

      const classBlocks = source.matchAll(/className=\{(?:[^{}]|\{[^{}]*\})*\}/gs);
      for (const match of classBlocks) {
        const block = match[0];
        if (leadingNoneRe.test(block) && clipRe.test(block)) {
          const lineNo = source.slice(0, match.index).split("\n").length;
          const entry = `${rel}:${lineNo}: ${block.replace(/\s+/g, " ").trim()}`;
          if (!violations.some((v) => v.startsWith(`${rel}:${lineNo}:`))) {
            violations.push(entry);
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });

  test("src/App.css collapses headerless code-block headers and strips nested Streamdown card/sidebar borders", () => {
    const css = readFileSync(resolve(ROOT_DIR, "src/App.css"), "utf-8");
    expect(css).toContain('[data-streamdown="code-block"][data-language=""] [data-streamdown="code-block-header"]');
    expect(css).toContain('[data-streamdown="code-block-actions"]');
    expect(css).toContain('[data-streamdown="code-block-wrap-button"]');
    expect(css).toContain('[data-streamdown="code-block-body"][data-wrapped="true"]');
    expect(css).toContain('[data-streamdown="table-wrapper"]');
    expect(css).toContain('.waypoint-message-row .waypoint-markdown li > .waypoint-md-p');
    expect(css).toContain('list-style-position: outside;');

    // Ensure @source-scanned Streamdown border-sidebar / p-2 / gap-2 defaults are explicitly neutralized
    const actionsRule = css.match(/\.waypoint-markdown \[data-streamdown="code-block-actions"\] \{[^}]+\}/)?.[0] ?? "";
    expect(actionsRule).toContain("border: 0;");
    expect(actionsRule).toContain("background: transparent;");
    expect(actionsRule).toContain("padding: 0;");

    const codeBlockRule = css.match(/\.waypoint-markdown \[data-streamdown="code-block"\] \{[^}]+\}/)?.[0] ?? "";
    expect(codeBlockRule).toContain("padding: 0;");
    expect(codeBlockRule).toContain("gap: 0;");

    const tableWrapperRule = css.match(/\.waypoint-markdown \[data-streamdown="table-wrapper"\] \{[^}]+\}/)?.[0] ?? "";
    expect(tableWrapperRule).toContain("padding: 0;");
    expect(tableWrapperRule).toContain("gap: 0;");
  });
  test("Tailwind class strings do not place leading-* before font-size text-* to prevent tailwind-merge override", () => {
    const targets = [
      resolve(ROOT_DIR, "src/App.tsx"),
      ...collectSourceFiles(resolve(ROOT_DIR, "src/components")),
      ...collectSourceFiles(resolve(ROOT_DIR, "src/waypoint")),
    ].sort();

    const violations: string[] = [];
    const leadingRe =
      /^(?:([a-z0-9]+):)?(?:leading-(?:none|tight|snug|normal|relaxed|loose)|leading-\[[^\]]+\])$/;
    const fontSizeRe =
      /^(?:([a-z0-9]+):)?(?:text-(?:xs|sm|base|lg|xl|2xl|3xl|4xl|5xl)|text-\[\d[^\]]*\])$/;

    function findLeadingBeforeFontSize(classStr: string): { leading: string; fontSize: string } | null {
      const tokens = classStr.trim().split(/\s+/).filter(Boolean);
      for (let i = 0; i < tokens.length; i++) {
        const leadMatch = tokens[i]!.match(leadingRe);
        if (!leadMatch) continue;
        const leadPrefix = leadMatch[1] ?? "";
        for (let j = i + 1; j < tokens.length; j++) {
          const sizeMatch = tokens[j]!.match(fontSizeRe);
          if (!sizeMatch) continue;
          const sizePrefix = sizeMatch[1] ?? "";
          if (leadPrefix === sizePrefix) {
            return { leading: tokens[i]!, fontSize: tokens[j]! };
          }
        }
      }
      return null;
    }

    const stringLiteralRe = /(["'`])(.*?)\1/gs;

    for (const filePath of targets) {
      const rel = relative(ROOT_DIR, filePath);
      const source = readFileSync(filePath, "utf-8");
      for (const match of source.matchAll(stringLiteralRe)) {
        const str = match[2] ?? "";
        const conflict = findLeadingBeforeFontSize(str);
        if (conflict) {
          violations.push(
            `${rel}: "${conflict.leading}" precedes "${conflict.fontSize}" in string literal "${str.trim()}"`,
          );
        }
      }
    }

    expect(violations).toEqual([]);
  });

  test("UI source files avoid invalid pt physical units and fractional rem text classes", () => {
    const targets = [
      resolve(ROOT_DIR, "src/App.css"),
      resolve(ROOT_DIR, "src/App.tsx"),
      ...collectSourceFiles(resolve(ROOT_DIR, "src/components")),
      ...collectSourceFiles(resolve(ROOT_DIR, "src/waypoint")),
    ].sort();

    const ptViolations: string[] = [];
    const fractionalRemViolations: string[] = [];

    const ptPattern = /\b\d+(?:\.\d+)?pt\b/;
    const fractionalRemPattern = /\btext-\[[0-9]*\.[0-9]+rem\]\b/;

    for (const filePath of targets) {
      const rel = relative(ROOT_DIR, filePath);
      const source = readFileSync(filePath, "utf-8");
      const lines = source.split("\n");
      lines.forEach((line: string, index: number) => {
        if (ptPattern.test(line)) {
          ptViolations.push(`${rel}:${index + 1}: ${line.trim()}`);
        }
        if (fractionalRemPattern.test(line)) {
          fractionalRemViolations.push(`${rel}:${index + 1}: ${line.trim()}`);
        }
      });
    }

    expect(ptViolations).toEqual([]);
    expect(fractionalRemViolations).toEqual([]);
  });

  test("src/App.css wraps Markdown blocks and inline code via overflow-wrap: anywhere while keeping wide blocks independently scrollable (#145)", () => {
    const css = readFileSync(resolve(ROOT_DIR, "src/App.css"), "utf-8");

    const markdownRule = css.match(/\.waypoint-markdown \{[^}]+\}/)?.[0] ?? "";
    expect(markdownRule).toContain("min-width: 0;");
    expect(markdownRule).toContain("max-width: 100%;");
    expect(markdownRule).toContain("overflow-wrap: anywhere;");

    const inlineCodeRule =
      css.match(/\.waypoint-markdown \[data-streamdown="inline-code"\] \{[^}]+\}/)?.[0] ?? "";
    expect(inlineCodeRule).toContain("overflow-wrap: anywhere;");

    const paragraphRule = css.match(/\.waypoint-md-p \{[^}]+\}/)?.[0] ?? "";
    expect(paragraphRule).toContain("overflow-wrap: anywhere;");

    const listItemRule = css.match(/\.waypoint-markdown li \{[^}]+\}/)?.[0] ?? "";
    expect(listItemRule).toContain("min-width: 0;");
    expect(listItemRule).toContain("max-width: 100%;");
    expect(listItemRule).toContain("overflow-wrap: anywhere;");

    const headingRule =
      css.match(/\.waypoint-markdown h1,\s*\.waypoint-markdown h2[\s\S]*?\{[^}]+\}/)?.[0] ?? "";
    expect(headingRule).toContain("overflow-wrap: anywhere;");

    const blockquoteRule =
      css.match(/\.waypoint-markdown \[data-streamdown="blockquote"\] \{[^}]+\}/)?.[0] ?? "";
    expect(blockquoteRule).toContain("min-width: 0;");
    expect(blockquoteRule).toContain("max-width: 100%;");
    expect(blockquoteRule).toContain("overflow-wrap: anywhere;");

    const calloutRule = css.match(/\.waypoint-markdown \.waypoint-callout \{[^}]+\}/)?.[0] ?? "";
    expect(calloutRule).toContain("min-width: 0;");
    expect(calloutRule).toContain("max-width: 100%;");
    expect(calloutRule).toContain("overflow-wrap: anywhere;");

    // Wide block containers keep independent horizontal scroll without wrapping code lines by default
    const codeBodyRule =
      css.match(/\.waypoint-markdown \[data-streamdown="code-block-body"\] \{[^}]+\}/)?.[0] ?? "";
    expect(codeBodyRule).toContain("overflow-x: auto;");
    expect(codeBodyRule).toContain("max-width: 100%;");

    const codePreRule =
      css.match(/\.waypoint-markdown \[data-streamdown="code-block-body"\] pre \{[^}]+\}/)?.[0] ?? "";
    expect(codePreRule).toContain("overflow-wrap: normal;");

    const tableScrollRule =
      css.match(/\.waypoint-markdown \[data-streamdown="table-wrapper"\] > div:last-child \{[^}]+\}/)?.[0] ?? "";
    expect(tableScrollRule).toContain("overflow-x: auto;");
    expect(tableScrollRule).toContain("max-width: 100%;");

    const tableInlineCodeRule =
      css.match(/\.waypoint-markdown \[data-streamdown="table"\] \[data-streamdown="inline-code"\] \{[^}]+\}/)?.[0] ?? "";
    expect(tableInlineCodeRule).toContain("white-space: nowrap;");
    expect(tableInlineCodeRule).toContain("overflow-wrap: normal;");

    const katexRule = css.match(/\.waypoint-markdown \.katex-display \{[^}]+\}/)?.[0] ?? "";
    expect(katexRule).toContain("overflow-x: auto;");
    expect(katexRule).toContain("max-width: 100%;");
  });
});
