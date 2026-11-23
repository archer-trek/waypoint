import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type {
  Clock,
  HomeserverRequest,
  HomeserverTransport,
  TransportResult,
} from "../adapters/types";
import { MatrixClient } from "./matrix-client";
import { saveSession, type RawMatrixEvent, type StoredRoomEvents } from "./session-store";

vi.mock("./workspace/TimelineView", () => ({
  TimelineView: ({
    items,
  }: {
    items: Array<{ kind: string; id: string; body?: string }>;
  }) => {
    if (items.some((item) => item.body === "TRIGGER_CRASH")) {
      throw new Error("Timeline render exploded");
    }
    return (
      <div data-testid="timeline-ok">
        {items.map((item) => (
          <div key={item.id}>{item.body}</div>
        ))}
      </div>
    );
  },
}));

import { TopicsWorkspace } from "./TopicsWorkspace";

class TestClock implements Clock {
  currentTimeMs(): number {
    return Date.UTC(2026, 10, 14, 12, 0, 0);
  }
  setTimeout(_handler: () => void, _timeoutMs: number): number {
    return 1;
  }
  clearTimeout(_id: number): void {}
}

class FakeHomeserver implements HomeserverTransport {
  async request(_input: HomeserverRequest): Promise<TransportResult> {
    return { type: "response", status: 200, body: { next_batch: "batch-2" } };
  }
}

function makeRoom(name: string, eventId: string, body: string, ts: number): StoredRoomEvents {
  const events: RawMatrixEvent[] = [
    {
      type: "m.room.message",
      event_id: eventId,
      sender: "@bot:example.com",
      origin_server_ts: ts,
      content: { msgtype: "m.text", body },
    },
  ];
  return {
    stateEvents: [
      { type: "m.room.create", state_key: "", origin_server_ts: 1000, content: {} },
      { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
      { type: "m.room.name", state_key: "", content: { name } },
    ],
    timelineEvents: events,
    readPositionEventId: eventId,
  };
}

describe("TopicsWorkspace detail ErrorBoundary", () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
    localStorage.clear();
  });

  afterEach(async () => {
    cleanup();
    vi.restoreAllMocks();
    await new Promise((resolve) => setTimeout(resolve, 10));
  });

  test("catches detail-pane render error while keeping sidebar usable and recovers on topic switch", async () => {
    const user = userEvent.setup();
    vi.spyOn(console, "error").mockImplementation(() => {});

    await saveSession({
      baseUrl: "https://matrix.example.com",
      userId: "@alice:example.com",
      accessToken: "tok-1",
      deviceId: "DEV1",
      syncCursor: "batch-1",
      accountData: {
        "im.waypoint.agents": { agents: [{ user_id: "@bot:example.com", name: "Hermes" }] },
      },
      rooms: {
        "!broken:example.com": makeRoom("故障 Topic", "$e1", "TRIGGER_CRASH", 2000),
        "!healthy:example.com": makeRoom("正常 Topic", "$e2", "正常消息内容", 3000),
      },
    });

    const client = new MatrixClient(new FakeHomeserver());
    await client.restore();

    render(<TopicsWorkspace client={client} clock={new TestClock()} viewportMode="wide" />);

    await user.click(screen.getByRole("button", { name: /故障 Topic/ }));

    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Topic 视图出现意外错误" })).toBeInTheDocument();
    // Sidebar remains accessible on wide viewport
    const healthyBtn = screen.getByRole("button", { name: /正常 Topic/ });
    expect(healthyBtn).toBeInTheDocument();

    // Switching to another topic automatically resets the detail ErrorBoundary
    await user.click(healthyBtn);

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(within(screen.getByTestId("timeline-ok")).getByText("正常消息内容")).toBeInTheDocument();
  });
});
