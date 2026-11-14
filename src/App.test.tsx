import { afterEach, describe, expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

let shouldThrowInWaypointApp = false;

vi.mock("./waypoint/WaypointApp", () => ({
  WaypointApp: () => {
    if (shouldThrowInWaypointApp) {
      throw new Error("Root render failure");
    }
    return <div>Waypoint 正常界面</div>;
  },
}));

import App from "./App";

describe("App root ErrorBoundary", () => {
  afterEach(() => {
    shouldThrowInWaypointApp = false;
    vi.restoreAllMocks();
  });

  test("catches WaypointApp render error and recovers on retry", async () => {
    const user = userEvent.setup();
    vi.spyOn(console, "error").mockImplementation(() => {});
    shouldThrowInWaypointApp = true;

    render(<App />);

    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "页面出现意外错误" })).toBeInTheDocument();
    expect(screen.queryByText("Waypoint 正常界面")).not.toBeInTheDocument();

    shouldThrowInWaypointApp = false;
    await user.click(screen.getByRole("button", { name: "重试" }));

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("Waypoint 正常界面")).toBeInTheDocument();
  });
});
