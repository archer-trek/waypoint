import type { Pluggable } from "unified";
import { defaultRehypePlugins } from "streamdown";

export type CalloutType = "note" | "tip" | "important" | "warning" | "caution";

export const CALLOUT_TYPES: readonly CalloutType[] = [
  "note",
  "tip",
  "important",
  "warning",
  "caution",
];

// Official CSS Color 4 named colors + transparent / currentcolor
const ALLOWED_NAMED_COLORS = new Set([
  "aliceblue", "antiquewhite", "aqua", "aquamarine", "azure", "beige", "bisque",
  "black", "blanchedalmond", "blue", "blueviolet", "brown", "burlywood", "cadetblue",
  "chartreuse", "chocolate", "coral", "cornflowerblue", "cornsilk", "crimson",
  "currentcolor", "cyan", "darkblue", "darkcyan", "darkgoldenrod", "darkgray",
  "darkgreen", "darkgrey", "darkkhaki", "darkmagenta", "darkolivegreen", "darkorange",
  "darkorchid", "darkred", "darksalmon", "darkseagreen", "darkslateblue",
  "darkslategray", "darkslategrey", "darkturquoise", "darkviolet", "deeppink",
  "deepskyblue", "dimgray", "dimgrey", "dodgerblue", "firebrick", "floralwhite",
  "forestgreen", "fuchsia", "gainsboro", "ghostwhite", "gold", "goldenrod", "gray",
  "green", "greenyellow", "grey", "honeydew", "hotpink", "indianred", "indigo",
  "ivory", "khaki", "lavender", "lavenderblush", "lawngreen", "lemonchiffon",
  "lightblue", "lightcoral", "lightcyan", "lightgoldenrodyellow", "lightgray",
  "lightgreen", "lightgrey", "lightpink", "lightsalmon", "lightseagreen",
  "lightskyblue", "lightslategray", "lightslategrey", "lightsteelblue", "lightyellow",
  "lime", "limegreen", "linen", "magenta", "maroon", "mediumaquamarine",
  "mediumblue", "mediumorchid", "mediumpurple", "mediumseagreen", "mediumslateblue",
  "mediumspringgreen", "mediumturquoise", "mediumvioletred", "midnightblue",
  "mintcream", "mistyrose", "moccasin", "navajowhite", "navy", "oldlace", "olive",
  "olivedrab", "orange", "orangered", "orchid", "palegoldenrod", "palegreen",
  "paleturquoise", "palevioletred", "papayawhip", "peachpuff", "peru", "pink",
  "plum", "powderblue", "purple", "rebeccapurple", "red", "rosybrown", "royalblue",
  "saddlebrown", "salmon", "sandybrown", "seagreen", "seashell", "sienna", "silver",
  "skyblue", "slateblue", "slategray", "slategrey", "snow", "springgreen",
  "steelblue", "tan", "teal", "thistle", "tomato", "transparent", "turquoise",
  "violet", "wheat", "white", "whitesmoke", "yellow", "yellowgreen",
]);

const TEXT_DECORATION_KEYWORDS = new Set([
  "none",
  "underline",
  "overline",
  "line-through",
  "solid",
  "double",
  "dotted",
  "dashed",
  "wavy",
]);

const HEX_COLOR_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const COLOR_FUNCTION_RE = /^(rgba?|hsla?)\(\s*([^()]+)\s*\)$/i;
const NUMERIC_COMPONENT_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)%?$/;
const HUE_COMPONENT_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:deg|rad|grad|turn)?$/i;
const FORBIDDEN_STYLE_SUBSTRING_RE = /(?:\/\*|\*\/|\\|!|;|url\s*\(|var\s*\(|expression\s*\(|javascript:|vbscript:|data:)/i;
const CALLOUT_MARKER_RE = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]$/i;

function decodeBasicHtmlEntities(input: string): string {
  return input
    .replace(/&quot;/gi, '"')
    .replace(/&#34;/g, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&");
}

function isValidColorFunctionArgs(fnName: string, rawArgs: string): boolean {
  const isHsl = fnName.startsWith("hsl");
  const hasComma = rawArgs.includes(",");

  if (hasComma) {
    if (rawArgs.includes("/")) {
      return false;
    }
    const parts = rawArgs.split(",").map((p) => p.trim());
    if (parts.length !== 3 && parts.length !== 4) {
      return false;
    }
    const [c0, c1, c2, alpha] = parts;
    if (!c0 || !c1 || !c2) {
      return false;
    }
    const firstValid = isHsl ? HUE_COMPONENT_RE.test(c0) : NUMERIC_COMPONENT_RE.test(c0);
    if (!firstValid || !NUMERIC_COMPONENT_RE.test(c1) || !NUMERIC_COMPONENT_RE.test(c2)) {
      return false;
    }
    if (alpha !== undefined && !NUMERIC_COMPONENT_RE.test(alpha)) {
      return false;
    }
    return true;
  }

  const slashParts = rawArgs.split("/").map((p) => p.trim());
  if (slashParts.length > 2 || !slashParts[0]) {
    return false;
  }
  const channels = slashParts[0].split(/\s+/);
  if (channels.length !== 3) {
    return false;
  }
  const [c0, c1, c2] = channels;
  if (!c0 || !c1 || !c2) {
    return false;
  }
  const firstValid = isHsl ? HUE_COMPONENT_RE.test(c0) : NUMERIC_COMPONENT_RE.test(c0);
  if (!firstValid || !NUMERIC_COMPONENT_RE.test(c1) || !NUMERIC_COMPONENT_RE.test(c2)) {
    return false;
  }
  if (slashParts.length === 2) {
    const alpha = slashParts[1];
    if (!alpha || !NUMERIC_COMPONENT_RE.test(alpha)) {
      return false;
    }
  }
  return true;
}

/** Validates a single CSS color literal (hex, named color, rgb/rgba, hsl/hsla). */
export function sanitizeColorLiteral(rawValue: string): string | undefined {
  const trimmed = rawValue.trim();
  if (!trimmed || trimmed.length > 80 || FORBIDDEN_STYLE_SUBSTRING_RE.test(trimmed)) {
    return undefined;
  }
  if (HEX_COLOR_RE.test(trimmed)) {
    return trimmed;
  }
  const lower = trimmed.toLowerCase();
  if (ALLOWED_NAMED_COLORS.has(lower)) {
    return lower;
  }
  const fnMatch = COLOR_FUNCTION_RE.exec(trimmed);
  if (fnMatch) {
    const fnName = fnMatch[1]!.toLowerCase();
    const args = fnMatch[2]!;
    if (isValidColorFunctionArgs(fnName, args)) {
      return `${fnName}(${args.replace(/\s+/g, " ").trim()})`;
    }
  }
  return undefined;
}

/** Validates safe `text-decoration` keyword/color combinations. */
function sanitizeTextDecoration(rawValue: string): string | undefined {
  const trimmed = rawValue.trim();
  if (!trimmed || trimmed.length > 80 || FORBIDDEN_STYLE_SUBSTRING_RE.test(trimmed)) {
    return undefined;
  }
  // Extract optional trailing color function if present, otherwise check whitespace tokens
  const fnMatch = /(rgba?\([^()]+\)|hsla?\([^()]+\))/i.exec(trimmed);
  let remaining = trimmed;
  let colorPart: string | undefined;
  if (fnMatch) {
    colorPart = sanitizeColorLiteral(fnMatch[1]!);
    if (!colorPart) {
      return undefined;
    }
    remaining = `${trimmed.slice(0, fnMatch.index)} ${trimmed.slice(fnMatch.index + fnMatch[0].length)}`.trim();
  }

  const tokens = remaining ? remaining.split(/\s+/) : [];
  const safeTokens: string[] = [];
  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (TEXT_DECORATION_KEYWORDS.has(lower)) {
      safeTokens.push(lower);
      continue;
    }
    if (!colorPart) {
      const maybeColor = sanitizeColorLiteral(token);
      if (maybeColor) {
        colorPart = maybeColor;
        continue;
      }
    }
    return undefined;
  }

  if (colorPart) {
    safeTokens.push(colorPart);
  }
  return safeTokens.length > 0 ? safeTokens.join(" ") : undefined;
}

/**
 * Sanitizes an inline `style` attribute at the CSS declaration level,
 * preserving only validated `color`, `background-color`, and `text-decoration`.
 */
export function sanitizeInlineStyle(rawStyle: string): string | undefined {
  const decoded = decodeBasicHtmlEntities(rawStyle);
  if (!decoded.trim() || /\/\*|\*\/|\\/.test(decoded)) {
    return undefined;
  }

  const declarations = new Map<string, string>();
  for (const rawDecl of decoded.split(";")) {
    const colonIdx = rawDecl.indexOf(":");
    if (colonIdx === -1) {
      continue;
    }
    const prop = rawDecl.slice(0, colonIdx).trim().toLowerCase();
    const val = rawDecl.slice(colonIdx + 1).trim();
    if (!prop || !val) {
      continue;
    }
    if (prop === "color" || prop === "background-color") {
      const safe = sanitizeColorLiteral(val);
      if (safe) {
        declarations.set(prop, safe);
      }
    } else if (prop === "text-decoration") {
      const safe = sanitizeTextDecoration(val);
      if (safe) {
        declarations.set(prop, safe);
      }
    }
  }

  if (declarations.size === 0) {
    return undefined;
  }
  return Array.from(declarations.entries())
    .map(([prop, val]) => `${prop}: ${val}`)
    .join("; ");
}

function parseHtmlAttributes(attrText: string): Record<string, string> | undefined {
  const attrs: Record<string, string> = {};
  let idx = 0;
  const len = attrText.length;

  while (idx < len) {
    while (idx < len && /\s/.test(attrText[idx]!)) {
      idx += 1;
    }
    if (idx >= len) {
      break;
    }

    const nameStart = idx;
    while (idx < len && /[a-zA-Z0-9:-]/.test(attrText[idx]!)) {
      idx += 1;
    }
    if (idx === nameStart) {
      return undefined;
    }
    const name = attrText.slice(nameStart, idx).toLowerCase();

    while (idx < len && /\s/.test(attrText[idx]!)) {
      idx += 1;
    }

    let value = "";
    if (idx < len && attrText[idx] === "=") {
      idx += 1;
      while (idx < len && /\s/.test(attrText[idx]!)) {
        idx += 1;
      }
      if (idx >= len) {
        return undefined;
      }
      const quote = attrText[idx];
      if (quote === '"' || quote === "'") {
        idx += 1;
        const valStart = idx;
        const closeQuoteIdx = attrText.indexOf(quote, valStart);
        if (closeQuoteIdx === -1) {
          return undefined;
        }
        value = attrText.slice(valStart, closeQuoteIdx);
        idx = closeQuoteIdx + 1;
        // Must have whitespace or end of attribute list after closing quote
        if (idx < len && !/\s/.test(attrText[idx]!)) {
          return undefined;
        }
      } else {
        const valStart = idx;
        while (idx < len && !/[\s<>"'`=]/.test(attrText[idx]!)) {
          idx += 1;
        }
        if (idx === valStart) {
          return undefined;
        }
        value = attrText.slice(valStart, idx);
      }
    }

    attrs[name] = value;
  }

  return attrs;
}

type ColorTagName = "span" | "font";

interface ParsedColorOpenTag {
  tag: ColorTagName;
  style: string | undefined;
}

function parseColorHtmlOpenTag(rawHtml: string): ParsedColorOpenTag | undefined {
  const trimmed = rawHtml.trim();
  const match = /^<(span|font)(?:\s+([\s\S]*))?>$/i.exec(trimmed);
  if (!match) {
    return undefined;
  }
  const tag = match[1]!.toLowerCase() as ColorTagName;
  const rawAttrs = (match[2] ?? "").trim();
  if (!rawAttrs || rawAttrs.endsWith("/")) {
    return undefined;
  }
  const attrs = parseHtmlAttributes(rawAttrs);
  if (!attrs) {
    return undefined;
  }

  if (tag === "span") {
    if (!Object.prototype.hasOwnProperty.call(attrs, "style")) {
      return undefined;
    }
    return {
      tag,
      style: sanitizeInlineStyle(attrs.style ?? ""),
    };
  }

  if (!Object.prototype.hasOwnProperty.call(attrs, "color")) {
    return undefined;
  }
  const decodedColor = decodeBasicHtmlEntities(attrs.color ?? "");
  const safeColor = sanitizeColorLiteral(decodedColor);
  return {
    tag,
    style: safeColor ? `color: ${safeColor}` : undefined,
  };
}

function parseColorHtmlCloseTag(rawHtml: string): ColorTagName | undefined {
  const match = /^<\/\s*(span|font)\s*>$/i.exec(rawHtml.trim());
  return match ? (match[1]!.toLowerCase() as ColorTagName) : undefined;
}

interface MdastNode {
  type: string;
  value?: string;
  children?: MdastNode[];
  data?: {
    hName?: string;
    hProperties?: Record<string, unknown>;
    [key: string]: unknown;
  };
}

interface OpenColorFrame {
  tag: ColorTagName;
  style: string | undefined;
  originalOpenNode: MdastNode;
  children: MdastNode[];
}

function rewriteInlineColorSpans(nodes: MdastNode[]): MdastNode[] {
  const stack: OpenColorFrame[] = [];
  const rootOutput: MdastNode[] = [];

  const currentTarget = (): MdastNode[] =>
    stack.length > 0 ? stack[stack.length - 1]!.children : rootOutput;

  for (const node of nodes) {

    if (node.type === "html" && typeof node.value === "string") {
      const open = parseColorHtmlOpenTag(node.value);
      if (open) {
        stack.push({
          tag: open.tag,
          style: open.style,
          originalOpenNode: node,
          children: [],
        });
        continue;
      }

      const closeTag = parseColorHtmlCloseTag(node.value);
      if (closeTag) {
        let matchIdx = -1;
        for (let i = stack.length - 1; i >= 0; i -= 1) {
          if (stack[i]!.tag === closeTag) {
            matchIdx = i;
            break;
          }
        }
        if (matchIdx !== -1) {
          // Unwind any unclosed inner frames above the matching opener as literal nodes
          while (stack.length - 1 > matchIdx) {
            const unclosed = stack.pop()!;
            const target = currentTarget();
            target.push(unclosed.originalOpenNode, ...unclosed.children);
          }
          const matched = stack.pop()!;
          const wrappedNode: MdastNode = {
            type: "waypointColorSpan",
            children: matched.children,
            data: {
              hName: "span",
              hProperties: matched.style ? { style: matched.style } : {},
            },
          };
          currentTarget().push(wrappedNode);
          continue;
        }
      }
    }

    currentTarget().push(node);
  }

  // Unwind any remaining unclosed openers back to literal nodes in original order
  while (stack.length > 0) {
    const unclosed = stack.shift()!;
    rootOutput.push(unclosed.originalOpenNode, ...unclosed.children);
  }

  return rootOutput;
}

function transformCalloutBlockquote(node: MdastNode): void {
  if (node.type !== "blockquote" || !node.children || node.children.length === 0) {
    return;
  }
  const firstPara = node.children[0];
  if (!firstPara || firstPara.type !== "paragraph" || !firstPara.children || firstPara.children.length === 0) {
    return;
  }
  const firstText = firstPara.children[0];
  if (!firstText || firstText.type !== "text" || typeof firstText.value !== "string") {
    return;
  }

  const nlIdx = firstText.value.search(/\r?\n/);
  let calloutType: CalloutType | undefined;

  if (nlIdx === -1) {
    const markerMatch = CALLOUT_MARKER_RE.exec(firstText.value.trim());
    if (!markerMatch) {
      return;
    }
    const nextNode = firstPara.children[1];
    if (firstPara.children.length > 1 && nextNode?.type !== "break") {
      return;
    }
    calloutType = markerMatch[1]!.toLowerCase() as CalloutType;
    firstPara.children.splice(0, nextNode?.type === "break" ? 2 : 1);
  } else {
    const firstLine = firstText.value.slice(0, nlIdx).trim();
    const markerMatch = CALLOUT_MARKER_RE.exec(firstLine);
    if (!markerMatch) {
      return;
    }
    calloutType = markerMatch[1]!.toLowerCase() as CalloutType;
    const newlineLen = firstText.value[nlIdx] === "\r" && firstText.value[nlIdx + 1] === "\n" ? 2 : 1;
    const rest = firstText.value.slice(nlIdx + newlineLen);
    if (rest.length > 0) {
      firstText.value = rest;
    } else {
      firstPara.children.splice(0, 1);
    }
  }

  if (firstPara.children.length === 0) {
    node.children.shift();
  }

  node.data = {
    ...(node.data ?? {}),
    hProperties: {
      ...(node.data?.hProperties ?? {}),
      dataCallout: calloutType,
    },
  };
}

function visitMdast(node: MdastNode): void {
  if (node.type === "blockquote") {
    transformCalloutBlockquote(node);
  }
  if (node.children) {
    node.children = rewriteInlineColorSpans(node.children);
    for (const child of node.children) {
      visitMdast(child);
    }
  }
}

/**
 * Remark plugin for Agent messages:
 * 1. Converts whitelisted `<span style="...">` and `<font color="...">` into safe color spans
 *    while leaving all other raw HTML untouched (so Streamdown renders them as literal text).
 * 2. Detects GitHub-style `[!NOTE]` / `[!TIP]` / `[!IMPORTANT]` / `[!WARNING]` / `[!CAUTION]`
 *    blockquotes and annotates them with `data-callout`.
 */
export const remarkAgentColorAndCallout: Pluggable = () => (tree: MdastNode) => {
  visitMdast(tree);
};

// Defense-in-depth regex for `rehype-sanitize` on serialized `span[style]`
const SAFE_SANITIZE_STYLE_RE =
  /^(?!.*(?:url|var|expression|javascript:|vbscript:|data:))(?:(?:color|background-color|text-decoration):\s*[#a-zA-Z0-9(),.%/\s-]+)(?:;\s*(?:color|background-color|text-decoration):\s*[#a-zA-Z0-9(),.%/\s-]+)*$/;

type SanitizeTuple = typeof defaultRehypePlugins.sanitize;

export function createAgentSanitizePlugin(): SanitizeTuple {
  const [pluginFn, baseSchema] = defaultRehypePlugins.sanitize as [
    unknown,
    {
      attributes?: Record<string, unknown[]>;
      [key: string]: unknown;
    },
  ];
  const baseAttributes = baseSchema.attributes ?? {};
  const extendedSchema = {
    ...baseSchema,
    attributes: {
      ...baseAttributes,
      span: [...(baseAttributes.span ?? []), ["style", SAFE_SANITIZE_STYLE_RE]],
      blockquote: [
        ...(baseAttributes.blockquote ?? []),
        ["dataCallout", ...CALLOUT_TYPES],
      ],
    },
  };
  return [pluginFn, extendedSchema] as SanitizeTuple;
}
