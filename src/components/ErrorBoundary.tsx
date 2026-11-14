import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertCircle, RefreshCw, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";

export type ErrorBoundaryProps = {
  children: ReactNode;
  onReset?: () => void;
  onReload?: () => void;
  resetKeys?: readonly unknown[];
  title?: string;
  description?: string;
};

type ErrorBoundaryState = {
  hasError: boolean;
  error: unknown;
  componentStack: string | null;
};

const INITIAL_STATE: ErrorBoundaryState = {
  hasError: false,
  error: null,
  componentStack: null,
};

function formatDiagnosticText(error: unknown, componentStack: string | null): string {
  const detailSections: string[] = [];
  if (error instanceof Error) {
    const headline = error.name
      ? `${error.name}: ${error.message || "未知错误"}`
      : error.message || "未知错误";
    if (error.stack) {
      detailSections.push(
        error.stack.includes(headline) ? error.stack : `${headline}\n${error.stack}`,
      );
    } else {
      detailSections.push(headline);
    }
  } else {
    detailSections.push(typeof error === "string" && error ? error : String(error ?? "未知错误"));
  }
  if (componentStack) {
    detailSections.push(`组件调用栈:${componentStack}`);
  }
  return detailSections.join("\n\n");
}

function resetKeysChanged(
  prevKeys: readonly unknown[] | undefined,
  nextKeys: readonly unknown[] | undefined,
): boolean {
  if (!prevKeys || !nextKeys) {
    return prevKeys !== nextKeys;
  }
  if (prevKeys.length !== nextKeys.length) {
    return true;
  }
  return prevKeys.some((item, index) => !Object.is(item, nextKeys[index]));
}

/** Reusable React error boundary rendering a Grokbot-monochrome recovery card. */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = INITIAL_STATE;

  static getDerivedStateFromError(error: unknown): Partial<ErrorBoundaryState> {
    return { hasError: true, error, componentStack: null };
  }

  componentDidCatch(_error: unknown, info: ErrorInfo): void {
    this.setState({
      componentStack: info.componentStack ?? null,
    });
  }

  componentDidUpdate(prevProps: ErrorBoundaryProps): void {
    if (
      this.state.hasError &&
      resetKeysChanged(prevProps.resetKeys, this.props.resetKeys)
    ) {
      this.setState(INITIAL_STATE);
    }
  }

  private handleReset = () => {
    this.props.onReset?.();
    this.setState(INITIAL_STATE);
  };

  private handleReload = () => {
    if (this.props.onReload) {
      this.props.onReload();
      return;
    }
    if (typeof window !== "undefined") {
      window.location.reload();
    }
  };

  render() {
    if (!this.state.hasError) {
      return this.props.children;
    }

    const title = this.props.title ?? "页面出现意外错误";
    const description =
      this.props.description ?? "当前视图遇到未捕获的渲染错误，你可以尝试重试或重新加载应用。";
    const diagnosticText = formatDiagnosticText(this.state.error, this.state.componentStack);

    return (
      <div
        role="alert"
        aria-live="assertive"
        className="flex h-full min-h-0 w-full flex-1 items-center justify-center bg-background p-6 text-foreground"
      >
        <div className="w-full max-w-md rounded-2xl border border-border bg-card p-6 text-card-foreground shadow-xs">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 inline-flex size-9 shrink-0 items-center justify-center rounded-lg border border-destructive/30 bg-destructive/10 text-destructive">
              <AlertCircle className="size-5" aria-hidden="true" />
            </div>
            <div className="min-w-0 flex-1 space-y-1">
              <h2 className="m-0 text-base font-semibold tracking-tight text-foreground">
                {title}
              </h2>
              <p className="m-0 text-sm leading-relaxed text-muted-foreground">
                {description}
              </p>
            </div>
          </div>

          <details className="mt-4 rounded-lg border border-border bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
            <summary className="cursor-pointer rounded-sm font-medium text-foreground outline-none select-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background">
              诊断详情
            </summary>
            <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-[0.75rem] leading-relaxed text-muted-foreground select-text">
              {diagnosticText}
            </pre>
          </details>

          <div className="mt-5 flex flex-wrap items-center gap-2.5">
            <Button type="button" onClick={this.handleReset}>
              <RotateCcw aria-hidden="true" />
              重试
            </Button>
            <Button type="button" variant="outline" onClick={this.handleReload}>
              <RefreshCw aria-hidden="true" />
              重新加载
            </Button>
          </div>
        </div>
      </div>
    );
  }
}
