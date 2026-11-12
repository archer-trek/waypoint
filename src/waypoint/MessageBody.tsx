import {
  Component,
  Fragment,
  isValidElement,
  type ComponentProps,
  type ErrorInfo,
  type ReactNode,
} from "react";
import {
  Streamdown,
  defaultRehypePlugins,
  type Components,
  type ExtraProps,
  type MathPlugin,
  type PluginConfig,
} from "streamdown";
import { createCjkPlugin } from "@streamdown/cjk";
import { createCodePlugin } from "@streamdown/code";
import { createMathPlugin } from "@streamdown/math";
import "katex/dist/katex.min.css";

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
    errorColor: "#b91c1c",
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
          const self = this;
          const wrappedOk = (code: number | null) => {
            let enterIdx = -1;
            for (let i = self.events.length - 1; i >= 0; i -= 1) {
              const entry = self.events[i];
              if (entry && entry[0] === "enter" && entry[1].type === "mathText") {
                enterIdx = i;
                break;
              }
            }
            if (enterIdx !== -1) {
              const openSeq = self.events[enterIdx + 1]?.[1];
              const openLen = openSeq ? openSeq.end.offset - openSeq.start.offset : 0;
              if (openLen === 1) {
                const afterOpen = self.events[enterIdx + 3]?.[1];
                const beforeClose = self.events[self.events.length - 4]?.[1];
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
    return <span className="waypoint-md-image-placeholder">{label}</span>;
  },
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
    <div className="waypoint-bubble-fallback">
      <div role="note" className="waypoint-render-fallback-hint">
        渲染异常，已显示原文
      </div>
      <div className="waypoint-bubble-raw">{body}</div>
    </div>
  );
}

export function MessageBody({ body }: { body: string }) {
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
        rehypePlugins={SAFE_REHYPE_PLUGINS}
        components={STREAMDOWN_COMPONENTS}
        controls={STREAMDOWN_CONTROLS}
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
