import {
  Component,
  Fragment,
  isValidElement,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ComponentType,
  type ErrorInfo,
  type ReactNode,
} from "react";
import { copyToClipboard } from "@/lib/utils";
import {
  CodeBlock,
  Streamdown,
  defaultComponents,
  defaultRehypePlugins,
  defaultRemarkPlugins,
  useIsCodeFenceIncomplete,
  type Components,
  type ExtraProps,
  type MathPlugin,
  type PluginConfig,
} from "streamdown";
import { createCjkPlugin } from "@streamdown/cjk";
import { createCodePlugin } from "@streamdown/code";
import { createMathPlugin } from "@streamdown/math";
import {
  Check,
  Copy,
  Info,
  Lightbulb,
  MessageSquareWarning,
  OctagonAlert,
  TriangleAlert,
  WrapText,
} from "lucide-react";
import "katex/dist/katex.min.css";
import {
  CALLOUT_TYPES,
  createAgentSanitizePlugin,
  remarkAgentColorAndCallout,
  type CalloutType,
} from "./markdown-color";

interface PandocMathTokenizerContext {
  events: Array<[string, { type: string; start: { offset: number }; end: { offset: number } }, unknown]>;
}

interface PandocMathExtension {
  _pandocWrapped?: boolean;
  tokenize: (
    this: PandocMathTokenizerContext,
    effects: unknown,
    ok: (code: number | null) => unknown,
    nok: (code: number | null) => unknown,
  ) => unknown;
}

function isWhitespaceToken(token: { type: string } | undefined): boolean {
  return token !== undefined && (token.type === "space" || token.type === "lineEnding");
}

function createPandocMathPlugin(): MathPlugin {
  const baseMath = createMathPlugin({
    singleDollarTextMath: true,
    errorColor: "var(--destructive)",
  });
  const baseRemark = baseMath.remarkPlugin;

  function pandocRemarkMath(this: { data: () => Record<string, unknown> }, ...args: unknown[]) {
    if (Array.isArray(baseRemark)) {
      const [fn, opts] = baseRemark as [(...a: unknown[]) => void, unknown?];
      fn.apply(this, opts !== undefined ? [opts] : args);
    } else if (typeof baseRemark === "function") {
      (baseRemark as (...a: unknown[]) => void).apply(this, args);
    }

    const data = this.data() as { micromarkExtensions?: Array<{ text?: Record<number, PandocMathExtension> }> };
    const exts = data.micromarkExtensions ?? [];
    for (const ext of exts) {
      const dollarConstruct = ext?.text?.[36];
      if (!dollarConstruct || dollarConstruct._pandocWrapped) {
        continue;
      }
      const origTokenize = dollarConstruct.tokenize;
      ext.text![36] = {
        ...dollarConstruct,
        _pandocWrapped: true,
        tokenize(effects, ok, nok) {
          const { events } = this;
          const wrappedOk = (code: number | null) => {
            let enterIdx = -1;
            for (let i = events.length - 1; i >= 0; i -= 1) {
              const entry = events[i];
              if (entry && entry[0] === "enter" && entry[1].type === "mathText") {
                enterIdx = i;
                break;
              }
            }
            if (enterIdx !== -1) {
              const openSeq = events[enterIdx + 1]?.[1];
              const openLen = openSeq ? openSeq.end.offset - openSeq.start.offset : 0;
              if (openLen === 1) {
                const afterOpen = events[enterIdx + 3]?.[1];
                const beforeClose = events[events.length - 4]?.[1];
                const followedByDigit = code !== null && code >= 48 && code <= 57;
                if (
                  isWhitespaceToken(afterOpen) ||
                  isWhitespaceToken(beforeClose) ||
                  followedByDigit
                ) {
                  return nok(code);
                }
              }
            }
            return ok(code);
          };
          return origTokenize.call(this, effects, wrappedOk, nok);
        },
      };
    }
  }

  return {
    ...baseMath,
    remarkPlugin: pandocRemarkMath as MathPlugin["remarkPlugin"],
  };
}

let cachedPlugins: PluginConfig | null = null;
let pluginInitFailed = false;

function getStreamdownPlugins(): PluginConfig | null {
  if (pluginInitFailed) {
    return null;
  }
  if (cachedPlugins) {
    return cachedPlugins;
  }
  try {
    cachedPlugins = {
      code: createCodePlugin(),
      math: createPandocMathPlugin(),
      cjk: createCjkPlugin(),
    };
    return cachedPlugins;
  } catch {
    pluginInitFailed = true;
    return null;
  }
}

const SAFE_REHYPE_PLUGINS = [
  defaultRehypePlugins.sanitize,
  defaultRehypePlugins.harden,
];

const AGENT_REMARK_PLUGINS = [
  ...Object.values(defaultRemarkPlugins),
  remarkAgentColorAndCallout,
];

const AGENT_REHYPE_PLUGINS = [
  createAgentSanitizePlugin(),
  defaultRehypePlugins.harden,
];

const CALLOUT_META: Record<
  CalloutType,
  {
    label: string;
    icon: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  }
> = {
  note: { label: "Note", icon: Info },
  tip: { label: "Tip", icon: Lightbulb },
  important: { label: "Important", icon: MessageSquareWarning },
  warning: { label: "Warning", icon: TriangleAlert },
  caution: { label: "Caution", icon: OctagonAlert },
};

function isCalloutType(value: unknown): value is CalloutType {
  return typeof value === "string" && (CALLOUT_TYPES as readonly string[]).includes(value);
}

function hasRenderableChildren(children: ReactNode): boolean {
  if (children == null || typeof children === "boolean") {
    return false;
  }
  if (typeof children === "string") {
    return children.trim().length > 0;
  }
  if (Array.isArray(children)) {
    return children.some(hasRenderableChildren);
  }
  return true;
}

const CODE_LANG_RE = /language-([^\s]+)/;
const CODE_START_LINE_RE = /startLine=(\d+)/;

function extractCodeText(children: ReactNode): string {
  if (typeof children === "string") {
    return children;
  }
  if (Array.isArray(children)) {
    return children.map(extractCodeText).join("");
  }
  if (isValidElement<{ children?: ReactNode }>(children)) {
    return extractCodeText(children.props.children);
  }
  return "";
}

function WaypointCodeCopyButton({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
      }
    };
  }, []);

  const handleCopy = async () => {
    if (copied) {
      return;
    }
    const ok = await copyToClipboard(code);
    if (!ok) {
      return;
    }
    setCopied(true);
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
    }
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      setCopied(false);
    }, 2000);
  };

  return (
    <>
      <button
        type="button"
        data-streamdown="code-block-copy-button"
        aria-label={STREAMDOWN_TRANSLATIONS.copyCode}
        title={STREAMDOWN_TRANSLATIONS.copyCode}
        onClick={handleCopy}
      >
        {copied ? (
          <Check aria-hidden="true" className="size-3.5" />
        ) : (
          <Copy aria-hidden="true" className="size-3.5" />
        )}
      </button>
      {copied ? (
        <output aria-live="polite" className="sr-only">
          {STREAMDOWN_TRANSLATIONS.copied}
        </output>
      ) : null}
    </>
  );
}

type CodeElementProps = ComponentProps<"code"> &
  ExtraProps & {
    "data-block"?: string;
  };

function WaypointCodeBlock({
  children,
  className,
  node,
  "data-block": _dataBlock,
  ...rest
}: CodeElementProps) {
  const [wrapped, setWrapped] = useState(false);
  const isIncomplete = useIsCodeFenceIncomplete();
  const language = className?.match(CODE_LANG_RE)?.at(1) ?? "";
  const metastring =
    typeof node?.properties?.metastring === "string" ? node.properties.metastring : undefined;
  const startLineMatch = metastring?.match(CODE_START_LINE_RE);
  const parsedStartLine = startLineMatch ? Number.parseInt(startLineMatch[1]!, 10) : undefined;
  const startLine = parsedStartLine !== undefined && parsedStartLine >= 1 ? parsedStartLine : undefined;
  const code = extractCodeText(children);
  const isSingleLine = !code.replace(/\n+$/, "").includes("\n");
  const wrapLabel = wrapped ? "取消折行" : "允许折行";

  return (
    <CodeBlock
      className={className}
      code={code}
      isIncomplete={isIncomplete}
      language={language}
      lineNumbers={false}
      startLine={startLine}
      data-wrapped={wrapped ? "true" : undefined}
      data-single-line={isSingleLine ? "true" : undefined}
      {...rest}
    >
      <button
        type="button"
        data-streamdown="code-block-wrap-button"
        aria-label={wrapLabel}
        aria-pressed={wrapped}
        title={wrapLabel}
        onClick={() => setWrapped((prev) => !prev)}
      >
        <WrapText aria-hidden="true" className="size-3.5" />
      </button>
      <WaypointCodeCopyButton code={code} />
    </CodeBlock>
  );
}

const DefaultCodeComponent = defaultComponents.code;

function WaypointCode(props: CodeElementProps) {
  if (!("data-block" in props)) {
    return <DefaultCodeComponent {...props} />;
  }
  return <WaypointCodeBlock {...props} />;
}

const STREAMDOWN_COMPONENTS: Components = {
  p: ({ children, node: _node, className, ...props }: ComponentProps<"div"> & ExtraProps) => {
    const items = (Array.isArray(children) ? children : [children]).filter(
      (child) => child != null && child !== "",
    );
    if (items.length === 1 && isValidElement(items[0])) {
      const itemProps = items[0].props as { node?: { tagName?: string }; [key: string]: unknown };
      const tagName = itemProps.node?.tagName;
      if (tagName === "img" || (tagName === "code" && "data-block" in itemProps)) {
        return <Fragment>{children}</Fragment>;
      }
    }
    return (
      <div
        className={className ? `waypoint-md-p ${className}` : "waypoint-md-p"}
        {...props}
      >
        {children}
      </div>
    );
  },
  img: ({ alt, src }: ComponentProps<"img"> & ExtraProps) => {
    const label = alt?.trim() ? alt : (src ?? "");
    return <span className="waypoint-md-image-placeholder text-muted-foreground">{label}</span>;
  },
  code: WaypointCode as Components["code"],
};

const STREAMDOWN_CONTROLS = {
  code: {
    copy: true,
    download: false,
  },
  table: false,
} as const;

const STREAMDOWN_REMEND = {
  katex: false,
  inlineKatex: false,
} as const;

const STREAMDOWN_LINK_SAFETY = {
  enabled: false,
} as const;

const STREAMDOWN_TRANSLATIONS = {
  copyCode: "复制代码",
  copied: "已复制",
} as const;

interface BoundaryProps {
  body: string;
  children: ReactNode;
}

interface BoundaryState {
  hasError: boolean;
}

class RichMessageErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { hasError: false };

  static getDerivedStateFromError(): BoundaryState {
    return { hasError: true };
  }

  componentDidUpdate(prevProps: BoundaryProps) {
    if (this.state.hasError && prevProps.body !== this.props.body) {
      this.setState({ hasError: false });
    }
  }

  componentDidCatch(_error: Error, _info: ErrorInfo) {
    // Graceful fallback is rendered; keep Topic and app open.
  }

  render() {
    if (this.state.hasError) {
      return <RawFallbackBody body={this.props.body} />;
    }
    return this.props.children;
  }
}

function RawFallbackBody({ body }: { body: string }) {
  return (
    <div className="waypoint-bubble-fallback min-w-0 max-w-full whitespace-normal">
      <div role="note" className="waypoint-render-fallback-hint mb-1.5 text-xs text-warning-foreground">
        渲染异常，已显示原文
      </div>
      <div className="waypoint-bubble-raw min-w-0 max-w-full whitespace-pre-wrap wrap-anywhere">{body}</div>
    </div>
  );
}

function normalizeExternalHref(href: string | undefined): string | undefined {
  if (typeof href !== "string") {
    return undefined;
  }
  const trimmed = href.trim();
  if (!trimmed || trimmed === "streamdown:incomplete-link") {
    return undefined;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === "http:" || parsed.protocol === "https:" || parsed.protocol === "mailto:") {
      return trimmed;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export function MessageBody({
  body,
  onOpenExternalUrl,
  richColor = false,
}: {
  body: string;
  onOpenExternalUrl?: (url: string) => void;
  richColor?: boolean;
}) {
  const onOpenExternalUrlRef = useRef(onOpenExternalUrl);
  useLayoutEffect(() => {
    onOpenExternalUrlRef.current = onOpenExternalUrl;
  }, [onOpenExternalUrl]);

  const components = useMemo<Components>(
    () => ({
      ...STREAMDOWN_COMPONENTS,
      blockquote: ({
        children,
        node: _node,
        className,
        ...props
      }: ComponentProps<"blockquote"> & ExtraProps & { "data-callout"?: string }) => {
        const calloutType = props["data-callout"];
        if (richColor && isCalloutType(calloutType)) {
          const meta = CALLOUT_META[calloutType];
          const Icon = meta.icon;
          const { "data-callout": _dc, ...rest } = props;
          const showBody = hasRenderableChildren(children);
          return (
            <div
              role="note"
              data-callout={calloutType}
              className={className ? `waypoint-callout ${className}` : "waypoint-callout"}
              {...(rest as ComponentProps<"div">)}
            >
              <div className="waypoint-callout-title">
                <Icon aria-hidden={true} className="waypoint-callout-icon size-4 shrink-0" />
                <span>{meta.label}</span>
              </div>
              {showBody ? <div className="waypoint-callout-body">{children}</div> : null}
            </div>
          );
        }
        return (
          <blockquote
            data-streamdown="blockquote"
            className={className}
            {...props}
          >
            {children}
          </blockquote>
        );
      },
      a: ({
        children,
        href,
        node: _node,
        target: _target,
        rel: _rel,
        onClick,
        ...props
      }: ComponentProps<"a"> & ExtraProps) => {
        const safeHref = normalizeExternalHref(href);
        if (!safeHref) {
          return <span>{children}</span>;
        }
        return (
          <a
            {...props}
            href={safeHref}
            rel="noopener noreferrer"
            onClick={(event) => {
              event.preventDefault();
              onClick?.(event);
              if (onOpenExternalUrlRef.current) {
                onOpenExternalUrlRef.current(safeHref);
              } else if (typeof window !== "undefined" && typeof window.open === "function") {
                window.open(safeHref, "_blank", "noopener,noreferrer");
              }
            }}
          >
            {children}
          </a>
        );
      },
    }),
    [richColor],
  );

  const plugins = getStreamdownPlugins();
  if (!plugins) {
    return <RawFallbackBody body={body} />;
  }

  return (
    <RichMessageErrorBoundary body={body}>
      <Streamdown
        className="waypoint-markdown"
        mode="static"
        plugins={plugins}
        remarkPlugins={richColor ? AGENT_REMARK_PLUGINS : undefined}
        rehypePlugins={richColor ? AGENT_REHYPE_PLUGINS : SAFE_REHYPE_PLUGINS}
        components={components}
        controls={STREAMDOWN_CONTROLS}
        tableMaxHeight={Infinity}
        remend={STREAMDOWN_REMEND}
        linkSafety={STREAMDOWN_LINK_SAFETY}
        lineNumbers={false}
        translations={STREAMDOWN_TRANSLATIONS}
      >
        {body}
      </Streamdown>
    </RichMessageErrorBoundary>
  );
}
