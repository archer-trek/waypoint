import { afterEach, describe, expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ErrorBoundary } from "@/components/ErrorBoundary";

function Boom({ shouldThrow }: { shouldThrow: boolean }) {
  if (shouldThrow) {
    throw new Error("Render explosion");
  }
  return <div>正常内容</div>;
}

describe("ErrorBoundary", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("catches child render error and renders accessible recovery UI", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    render(
      <ErrorBoundary>
        <Boom shouldThrow />
      </ErrorBoundary>,
    );

    const alert = screen.getByRole("alert");
    expect(alert).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "页面出现意外错误" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
    expect(screen.queryByText("正常内容")).not.toBeInTheDocument();
  });

  test("resets boundary state and calls onReset when clicking retry", async () => {
    const user = userEvent.setup();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const onReset = vi.fn();
    let shouldThrow = true;

    function Recoverable() {
      return <Boom shouldThrow={shouldThrow} />;
    }

    render(
      <ErrorBoundary
        onReset={() => {
          shouldThrow = false;
          onReset();
        }}
      >
        <Recoverable />
      </ErrorBoundary>,
    );

    expect(screen.getByRole("alert")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "重试" }));

    expect(onReset).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("正常内容")).toBeInTheDocument();
  });

  test("toggles diagnostic details summary to reveal error message", async () => {
    const user = userEvent.setup();
    vi.spyOn(console, "error").mockImplementation(() => {});

    render(
      <ErrorBoundary>
        <Boom shouldThrow />
      </ErrorBoundary>,
    );

    const summary = screen.getByText("诊断详情");
    expect(screen.getByText(/Render explosion/)).not.toBeVisible();

    await user.click(summary);

    expect(screen.getByText(/Render explosion/)).toBeVisible();
  });

  test("invokes onReload when clicking reload button", async () => {
    const user = userEvent.setup();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const onReload = vi.fn();

    render(
      <ErrorBoundary onReload={onReload}>
        <Boom shouldThrow />
      </ErrorBoundary>,
    );

    await user.click(screen.getByRole("button", { name: "重新加载" }));

    expect(onReload).toHaveBeenCalledTimes(1);
  });

  test("automatically resets when resetKeys change", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    const { rerender } = render(
      <ErrorBoundary resetKeys={["topic-1"]}>
        <Boom shouldThrow />
      </ErrorBoundary>,
    );

    expect(screen.getByRole("alert")).toBeInTheDocument();

    rerender(
      <ErrorBoundary resetKeys={["topic-2"]}>
        <Boom shouldThrow={false} />
      </ErrorBoundary>,
    );

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("正常内容")).toBeInTheDocument();
  });
});
