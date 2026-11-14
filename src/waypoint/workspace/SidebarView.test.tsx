import { describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { TopicSummary } from "../topics";
import { EmptyDetailView } from "./EmptyDetailView";
import { SidebarView, type SidebarViewProps } from "./SidebarView";

function makeTopic(overrides: Partial<TopicSummary> = {}): TopicSummary {
  return {
    roomId: "!room1:example.com",
    name: "架构讨论",
    botDisplayName: "Hermes",
    lastActivityTs: Date.UTC(2026, 10, 14, 12, 0, 0),
    pinned: false,
    unread: false,
    readPositionUnknown: false,
    responding: false,
    unavailable: false,
    ...overrides,
  };
}

function renderSidebar(overrides: Partial<SidebarViewProps> = {}) {
  const props: SidebarViewProps = {
    pageEnterClass: "",
    reauthRequired: false,
    showDetail: true,
    reauthBanner: null,
    topics: [makeTopic()],
    activeTopicId: undefined,
    registeredAgentsCount: 1,
    nowMs: Date.UTC(2026, 10, 14, 12, 5, 0),
    isNarrow: false,
    onOpenSettings: vi.fn(),
    onOpenCreateForm: vi.fn(),
    onOpenTopic: vi.fn(),
    ...overrides,
  };
  return {
    ...render(<SidebarView {...props} />),
    props,
  };
}

describe("SidebarView & EmptyDetailView", () => {
  test("renders desktop header with Tauri drag region, traffic-light clearance, and shadcn Button triggers", () => {
    const { props } = renderSidebar({ isNarrow: false });
    const sidebar = screen.getByRole("complementary", { name: "Topic 列表" });

    expect(sidebar).toHaveClass("waypoint-sidebar", "bg-background", "border-r", "border-border");
    expect(within(sidebar).getByText("已连接")).toHaveClass("sr-only");
    expect(within(sidebar).getByRole("heading", { level: 1, name: "Topic" })).toHaveClass("sr-only");
    expect(within(sidebar).queryByRole("searchbox")).not.toBeInTheDocument();
    expect(within(sidebar).queryByRole("img")).not.toBeInTheDocument();

    const header = sidebar.querySelector(".waypoint-sidebar-header");
    expect(header).toHaveAttribute("data-tauri-drag-region");
    expect(header).toHaveClass("pl-[76px]");

    const settingsBtn = within(sidebar).getByRole("button", { name: "设置" });
    const createBtn = within(sidebar).getByRole("button", { name: "新建 Topic" });
    expect(settingsBtn).toHaveAttribute("data-slot", "button");
    expect(createBtn).toHaveAttribute("data-slot", "button");
    expect(createBtn).toHaveClass("waypoint-create-topic-btn");

    fireEvent.click(settingsBtn);
    fireEvent.click(createBtn);
    expect(props.onOpenSettings).toHaveBeenCalledTimes(1);
    expect(props.onOpenCreateForm).toHaveBeenCalledTimes(1);
  });

  test("omits macOS traffic-light padding on narrow mobile viewport and disables create during reauth", () => {
    renderSidebar({ isNarrow: true, reauthRequired: true });
    const sidebar = screen.getByRole("complementary", { name: "Topic 列表" });

    expect(sidebar).toHaveClass("w-full");
    expect(sidebar.querySelector(".waypoint-sidebar-header")).not.toHaveClass("pl-[76px]");
    expect(within(sidebar).getByRole("button", { name: "新建 Topic" })).toBeDisabled();
  });

  test("renders Grokbot monochrome active, unread, pinned, unavailable, and status states while preserving hooks", () => {
    const onOpenTopic = vi.fn();
    renderSidebar({
      activeTopicId: "!active:example.com",
      registeredAgentsCount: 2,
      onOpenTopic,
      topics: [
        makeTopic({
          roomId: "!active:example.com",
          name: "活跃未读置顶",
          unread: true,
          pinned: true,
          sendStatus: "failed",
          responding: true,
        }),
        makeTopic({
          roomId: "!unconfirmed:example.com",
          name: "发送中话题",
          sendStatus: "unconfirmed",
          unavailable: true,
        }),
      ],
    });

    const activeRow = screen.getByRole("button", { name: "活跃未读置顶" });
    expect(activeRow).toHaveClass("waypoint-topic-row", "active", "bg-accent", "text-accent-foreground");
    expect(activeRow).toHaveAttribute("data-unread", "true");
    expect(activeRow).toHaveAttribute("data-pinned", "true");
    expect(activeRow.querySelector(".waypoint-unread-dot")).toHaveClass("bg-foreground");
    expect(activeRow.querySelector(".waypoint-topic-name")).toHaveClass("unread");
    expect(activeRow.querySelector(".waypoint-topic-name")).toHaveStyle({ fontWeight: "700" });
    expect(activeRow.querySelector(".waypoint-topic-row-pin")).toHaveAttribute("data-slot", "badge");
    expect(within(activeRow).getByRole("img", { name: "失败" })).toHaveClass("bg-destructive");
    expect(activeRow.querySelector(".waypoint-topic-row-time")).toHaveClass("tabular-nums");
    expect(activeRow.querySelector(".waypoint-topic-row-bot")).toHaveTextContent("Hermes");
    expect(activeRow.querySelector(".waypoint-topic-row-responding")).toHaveTextContent("正在回应");

    const secondRow = screen.getByRole("button", { name: "发送中话题" });
    expect(secondRow).toHaveClass("unavailable");
    expect(secondRow).toHaveAttribute("data-unavailable", "true");
    expect(secondRow.querySelector(".waypoint-topic-name")).toHaveStyle({ fontWeight: "400" });
    expect(secondRow.querySelector(".waypoint-topic-row-unavailable")).toHaveAttribute("data-slot", "badge");
    expect(within(secondRow).getByRole("img", { name: "未确认" })).toHaveClass("animate-spin");

    fireEvent.click(activeRow);
    expect(onOpenTopic).toHaveBeenCalledWith("!active:example.com");
  });

  test("omits secondary row for single bot when not responding", () => {
    renderSidebar({
      registeredAgentsCount: 1,
      topics: [makeTopic({ responding: false })],
    });
    const row = screen.getByRole("button", { name: "架构讨论" });
    expect(row.querySelector(".waypoint-topic-row-secondary")).toBeNull();
    expect(row.querySelector(".waypoint-topic-row-bot")).toBeNull();
  });

  test("renders empty list guidance on narrow viewport and EmptyDetailView on wide viewport", () => {
    const onOpenCreateForm = vi.fn();
    const { rerender } = render(
      <SidebarView
        pageEnterClass=""
        reauthRequired={false}
        showDetail={false}
        reauthBanner={null}
        topics={[]}
        registeredAgentsCount={1}
        nowMs={Date.UTC(2026, 10, 14, 12, 0, 0)}
        isNarrow={true}
        onOpenSettings={vi.fn()}
        onOpenCreateForm={onOpenCreateForm}
        onOpenTopic={vi.fn()}
      />,
    );

    const sidebar = screen.getByRole("complementary", { name: "Topic 列表" });
    expect(sidebar.querySelector(".waypoint-list-empty")).not.toBeNull();
    expect(within(sidebar).getByText("暂无 Topic")).toHaveClass("sr-only");
    const narrowGuide = within(sidebar).getByRole("region", { name: "Topic 引导" });
    expect(narrowGuide).not.toHaveTextContent("Alt + N");
    const narrowCta = within(narrowGuide).getByRole("button", { name: "新建一条 Topic" });
    expect(narrowCta).toHaveAttribute("data-slot", "button");
    fireEvent.click(narrowCta);
    expect(onOpenCreateForm).toHaveBeenCalledTimes(1);

    rerender(
      <EmptyDetailView
        reauthBanner={null}
        topicsCount={2}
        reauthRequired={false}
        onOpenCreateForm={onOpenCreateForm}
      />,
    );

    const detailGuide = screen.getByRole("region", { name: "Topic 引导" });
    expect(detailGuide).toHaveClass("waypoint-empty-detail");
    expect(detailGuide.querySelector(".waypoint-empty-card")).not.toBeNull();
    expect(detailGuide.querySelector(".waypoint-kbd-hint")).toHaveTextContent("Alt + N");
    expect(within(detailGuide).getByText("选择一条 Topic，或新建一条 Topic 开始交流。")).toBeInTheDocument();
  });
});
