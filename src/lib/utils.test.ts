import { describe, expect, test } from "vitest";
import { cn } from "./utils";

async function readAppCss(): Promise<string> {
  // @ts-expect-error Node.js built-in fs in Vitest test runner
  const { readFileSync } = await import("node:fs");
  // @ts-expect-error Node.js built-in path in Vitest test runner
  const { resolve } = await import("node:path");
  const cwd = (globalThis as unknown as { process: { cwd: () => string } }).process.cwd();
  return readFileSync(resolve(cwd, "src/App.css"), "utf-8") as string;
}

describe("cn utility", () => {
  test("merges class names and skips falsy values", () => {
    const cond = false;
    expect(cn("foo", cond && "bar", undefined, null, "baz")).toBe("foo baz");
  });

  test("resolves conflicting Tailwind utility classes", () => {
    expect(cn("px-2 py-1", "px-4")).toBe("py-1 px-4");
    expect(cn("bg-primary text-sm", "bg-destructive text-base")).toBe(
      "bg-destructive text-base",
    );
  });
});

describe("Tailwind v4 & Grokbot theme tokens in App.css", () => {
  test("configures Tailwind v4 import, dark variant, and @theme inline mappings", async () => {
    const css = await readAppCss();
    expect(css).toContain('@import "tailwindcss";');
    expect(css).toContain("@custom-variant dark");
    expect(css).toContain("@theme inline");
    const themeMappings = [
      "--color-background: var(--background);",
      "--color-foreground: var(--foreground);",
      "--color-card: var(--card);",
      "--color-card-foreground: var(--card-foreground);",
      "--color-popover: var(--popover);",
      "--color-popover-foreground: var(--popover-foreground);",
      "--color-primary: var(--primary);",
      "--color-primary-foreground: var(--primary-foreground);",
      "--color-secondary: var(--secondary);",
      "--color-secondary-foreground: var(--secondary-foreground);",
      "--color-muted: var(--muted);",
      "--color-muted-foreground: var(--muted-foreground);",
      "--color-accent: var(--accent);",
      "--color-accent-foreground: var(--accent-foreground);",
      "--color-destructive: var(--destructive);",
      "--color-destructive-foreground: var(--destructive-foreground);",
      "--color-border: var(--border);",
      "--color-input: var(--input);",
      "--color-ring: var(--ring);",
    ];
    for (const mapping of themeMappings) {
      expect(css).toContain(mapping);
    }
  });

  test("defines Grokbot monochrome light and dark semantic tokens", async () => {
    const css = await readAppCss();
    const requiredTokens = [
      "--background:",
      "--foreground:",
      "--card-foreground:",
      "--popover:",
      "--popover-foreground:",
      "--primary:",
      "--primary-foreground:",
      "--secondary:",
      "--secondary-foreground:",
      "--muted:",
      "--muted-foreground:",
      "--accent:",
      "--accent-foreground:",
      "--destructive:",
      "--destructive-foreground:",
      "--border:",
      "--input:",
      "--ring:",
      "--radius:",
    ];
    for (const token of requiredTokens) {
      expect(css).toContain(token);
    }
    expect(css).toContain(".dark");
    expect(css).toContain('[data-theme="dark"]');
  });
});
