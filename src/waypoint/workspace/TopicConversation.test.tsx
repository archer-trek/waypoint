import { createRef, useState } from "react";
import { describe, expect, test, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MessageBody } from "../MessageBody";
import type { TopicSummary, TimelineItem } from "../topics";
import { ComposerView } from "./ComposerView";
import { TimelineView } from "./TimelineView";
import { TopicHeaderView } from "./TopicHeaderView";

const sampleTopic: TopicSummary = {
  roomId: "!topic-1:example.com",
  name: "Grokbot 架构讨论",
  description: "第一行说明\n第二行补充",
  agentUserId: "@bot:example.com",
  botDisplayName: "Architect Bot",
  pinned: false,
  unread: false,
  readPositionUnknown: false,
  unavailable: false,
  responding: false,
};

describe("TopicHeaderView (#89)", () => {
  test("renders scroll-aware elevation: transparent border when at top, translucent border-border/60 when elevated (ADR-0028)", () => {
    const onGoBack = vi.fn();
    const onToggleDescription = vi.fn();
    const { rerender } = render(
      <TopicHeaderView
        isNarrow
        elevated={false}
        topic={sampleTopic}
        descriptionExpanded={false}
        overflowMenuOpen={false}
        overflowMenuRef={createRef()}
        editing={false}
        editSubmitting={false}
        deleteConfirmOpen={false}
        deleting={false}
        reauthRequired={false}
        pinPending={false}
        onGoBack={onGoBack}
        onToggleDescription={onToggleDescription}
        onToggleOverflowMenu={vi.fn()}
        onCloseOverflowMenu={vi.fn()}
        onTogglePin={vi.fn()}
        onOpenEditForm={vi.fn()}
        onOpenDeleteConfirm={vi.fn()}
      />,
    );

    const header = screen.getByRole("banner");
    expect(header).toHaveAttribute("data-tauri-drag-region", "deep");
    expect(header).toHaveClass(
      "waypoint-topic-header",
      "sticky",
      "top-0",
      "border-transparent",
    );
    expect(header).not.toHaveAttribute("data-elevated");
    expect(header).toHaveTextContent("Grokbot 架构讨论");
    expect(header).not.toHaveTextContent("@bot:example.com");
    const metaEl = header.querySelector(".waypoint-topic-header-meta") as HTMLElement;
    expect(metaEl).not.toBeNull();
    expect(metaEl).toHaveClass("flex-row");
    expect(metaEl.querySelector(".waypoint-topic-bot-name")).toHaveTextContent("Architect Bot");
    expect(metaEl.querySelector(".waypoint-topic-meta-separator")).toHaveTextContent("·");

    const backBtn = screen.getByRole("button", { name: "返回" });
    expect(backBtn).toHaveAttribute("data-slot", "button");

    const descBtn = screen.getByRole("button", { name: /第一行说明/ });
    expect(descBtn).toHaveClass("waypoint-topic-description", "truncate");
    expect(descBtn).toHaveAttribute("aria-expanded", "false");

    // Elevated state on scroll
    rerender(
      <TopicHeaderView
        isNarrow
        elevated={true}
        topic={sampleTopic}
        descriptionExpanded={false}
        overflowMenuOpen={false}
        overflowMenuRef={createRef()}
        editing={false}
        editSubmitting={false}
        deleteConfirmOpen={false}
        deleting={false}
        reauthRequired={false}
        pinPending={false}
        onGoBack={onGoBack}
        onToggleDescription={onToggleDescription}
        onToggleOverflowMenu={vi.fn()}
        onCloseOverflowMenu={vi.fn()}
        onTogglePin={vi.fn()}
        onOpenEditForm={vi.fn()}
        onOpenDeleteConfirm={vi.fn()}
      />,
    );

    expect(header).toHaveAttribute("data-elevated", "true");
    expect(header).toHaveClass(
      "bg-background/90",
      "backdrop-blur-md",
      "border-b",
      "border-border/60",
    );
  });

  test("uses shadcn DropdownMenu for topic actions, closes on outside click/selection, and preserves desktop/sr-only action buttons", async () => {
    const user = userEvent.setup();
    const onToggleOverflowMenu = vi.fn();
    const onCloseOverflowMenu = vi.fn();
    const onTogglePin = vi.fn();
    const onOpenEditForm = vi.fn();
    const onOpenDeleteConfirm = vi.fn();

    function ControlledHeaderHarness() {
      const [overflowMenuOpen, setOverflowMenuOpen] = useState(false);
      return (
        <div>
          <div data-testid="outside-area">Outside</div>
          <TopicHeaderView
            isNarrow={false}
            topic={sampleTopic}
            descriptionExpanded={false}
            overflowMenuOpen={overflowMenuOpen}
            overflowMenuRef={createRef()}
            editing={false}
            editSubmitting={false}
            deleteConfirmOpen={false}
            deleting={false}
            reauthRequired={false}
            pinPending={false}
            onGoBack={vi.fn()}
            onToggleDescription={vi.fn()}
            onToggleOverflowMenu={() => {
              onToggleOverflowMenu();
              setOverflowMenuOpen((prev) => !prev);
            }}
            onCloseOverflowMenu={() => {
              onCloseOverflowMenu();
              setOverflowMenuOpen(false);
            }}
            onTogglePin={onTogglePin}
            onOpenEditForm={onOpenEditForm}
            onOpenDeleteConfirm={onOpenDeleteConfirm}
          />
        </div>
      );
    }

    render(<ControlledHeaderHarness />);

    const header = screen.getByRole("banner");
    expect(header).toHaveClass("waypoint-topic-header");
    expect(header).not.toHaveClass("max-w-3xl", "mx-auto");
    const headerBar = header.querySelector(".waypoint-topic-header-bar") as HTMLElement;
    expect(headerBar).not.toBeNull();
    expect(headerBar).not.toHaveClass("max-w-3xl", "mx-auto");

    const trigger = screen.getByRole("button", { name: "话题操作" });
    await user.click(trigger);
    expect(onToggleOverflowMenu).toHaveBeenCalledTimes(1);

    const menu = screen.getByRole("menu", { name: "话题操作" });
    expect(menu).toHaveAttribute("data-slot", "dropdown-menu-content");
    expect(within(menu).getByRole("menuitem", { name: "置顶" })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: "编辑" })).toBeInTheDocument();
    const deleteItem = within(menu).getByRole("menuitem", { name: "删除" });
    expect(deleteItem).toHaveAttribute("data-variant", "destructive");

    onCloseOverflowMenu.mockClear();
    await user.click(screen.getByTestId("outside-area"));
    expect(onCloseOverflowMenu).toHaveBeenCalled();
    expect(screen.queryByRole("menu", { name: "话题操作" })).not.toBeInTheDocument();

    await user.click(trigger);
    const reopenedMenu = screen.getByRole("menu", { name: "话题操作" });
    onCloseOverflowMenu.mockClear();
    await user.click(within(reopenedMenu).getByRole("menuitem", { name: "编辑" }));
    expect(onCloseOverflowMenu).toHaveBeenCalled();
    expect(onOpenEditForm).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu", { name: "话题操作" })).not.toBeInTheDocument();

    expect(screen.getByRole("button", { name: "置顶" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "编辑" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "删除" })).toBeInTheDocument();
    expect(document.querySelector(".waypoint-desktop-actions")).toBeNull();
  });

  test("narrow TopicHeaderView renders anchored pull-down DropdownMenu under trigger (iOS 14+ UIMenu / M3 Overflow pattern)", async () => {
    const user = userEvent.setup();
    const onTogglePin = vi.fn();
    const onOpenEditForm = vi.fn();
    const onOpenDeleteConfirm = vi.fn();

    function NarrowHeaderHarness() {
      const [open, setOpen] = useState(false);
      return (
        <TopicHeaderView
          isNarrow={true}
          elevated={false}
          topic={sampleTopic}
          descriptionExpanded={false}
          overflowMenuOpen={open}
          overflowMenuRef={createRef()}
          editing={false}
          editSubmitting={false}
          deleteConfirmOpen={false}
          deleting={false}
          reauthRequired={false}
          pinPending={false}
          onGoBack={vi.fn()}
          onToggleDescription={vi.fn()}
          onToggleOverflowMenu={() => setOpen((prev) => !prev)}
          onCloseOverflowMenu={() => setOpen(false)}
          onTogglePin={onTogglePin}
          onOpenEditForm={onOpenEditForm}
          onOpenDeleteConfirm={onOpenDeleteConfirm}
        />
      );
    }

    render(<NarrowHeaderHarness />);

    const trigger = screen.getByRole("button", { name: "话题操作" });
    await user.click(trigger);

    // Anchored Pull-down DropdownMenu should be mounted right under the trigger
    const menu = screen.getByRole("menu", { name: "话题操作" });
    expect(menu).toHaveAttribute("data-slot", "dropdown-menu-content");

    // Verify items
    const pinItem = within(menu).getByRole("menuitem", { name: "置顶" });
    const editItem = within(menu).getByRole("menuitem", { name: "编辑" });
    const deleteItem = within(menu).getByRole("menuitem", { name: "删除" });
    expect(pinItem).toBeInTheDocument();
    expect(editItem).toBeInTheDocument();
    expect(deleteItem).toHaveAttribute("data-variant", "destructive");

    // Click edit invokes callback and closes menu
    await user.click(editItem);
    expect(onOpenEditForm).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu", { name: "话题操作" })).not.toBeInTheDocument();
  });

  test("renders compact two-line bound Bot + Description header, expands Description below Bot name, and handles bot-only or invalid binding (#166)", async () => {
    const user = userEvent.setup();
    const onToggleDescription = vi.fn();
    const baseProps = {
      isNarrow: true,
      elevated: false,
      overflowMenuOpen: false,
      overflowMenuRef: createRef<HTMLDivElement>(),
      editing: false,
      editSubmitting: false,
      deleteConfirmOpen: false,
      deleting: false,
      reauthRequired: false,
      pinPending: false,
      onGoBack: vi.fn(),
      onToggleDescription,
      onToggleOverflowMenu: vi.fn(),
      onCloseOverflowMenu: vi.fn(),
      onTogglePin: vi.fn(),
      onOpenEditForm: vi.fn(),
      onOpenDeleteConfirm: vi.fn(),
    };

    const { rerender } = render(
      <TopicHeaderView {...baseProps} topic={sampleTopic} descriptionExpanded={false} />,
    );
    const header = screen.getByRole("banner");
    const metaCollapsed = header.querySelector(".waypoint-topic-header-meta") as HTMLElement;
    expect(metaCollapsed).toHaveClass("flex-row");
    expect(metaCollapsed.querySelector(".waypoint-topic-bot-name")).toHaveTextContent("Architect Bot");
    expect(metaCollapsed.querySelector(".waypoint-topic-meta-separator")).toHaveTextContent("·");
    const descCollapsed = within(metaCollapsed).getByRole("button", { name: /第一行说明/ });
    expect(descCollapsed).toHaveAttribute("aria-expanded", "false");
    expect(descCollapsed).toHaveClass("truncate");

    await user.click(descCollapsed);
    expect(onToggleDescription).toHaveBeenCalledTimes(1);

    rerender(<TopicHeaderView {...baseProps} topic={sampleTopic} descriptionExpanded={true} />);
    const metaExpanded = header.querySelector(".waypoint-topic-header-meta") as HTMLElement;
    expect(metaExpanded).toHaveClass("flex-col");
    expect(metaExpanded.querySelector(".waypoint-topic-meta-separator")).toBeNull();
    const botExpanded = metaExpanded.querySelector(".waypoint-topic-bot-name") as HTMLElement;
    const descExpanded = within(metaExpanded).getByRole("button", { name: /第一行说明/ });
    expect(botExpanded).toHaveTextContent("Architect Bot");
    expect(descExpanded).toHaveClass("expanded", "whitespace-pre-wrap");
    expect(descExpanded).toHaveAttribute("aria-expanded", "true");
    expect(botExpanded.compareDocumentPosition(descExpanded) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // Bot without Description: shows Bot name only, no separator or description button
    rerender(
      <TopicHeaderView
        {...baseProps}
        topic={{ ...sampleTopic, description: undefined }}
        descriptionExpanded={false}
      />,
    );
    expect(header.querySelector(".waypoint-topic-bot-name")).toHaveTextContent("Architect Bot");
    expect(header.querySelector(".waypoint-topic-meta-separator")).toBeNull();
    expect(header.querySelector(".waypoint-topic-description")).toBeNull();

    // Invalid binding with Description: omits Bot name and separator, shows Description only
    rerender(
      <TopicHeaderView
        {...baseProps}
        topic={{ ...sampleTopic, botDisplayName: undefined, description: "仅保留说明" }}
        descriptionExpanded={false}
      />,
    );
    expect(header.querySelector(".waypoint-topic-bot-name")).toBeNull();
    expect(header.querySelector(".waypoint-topic-meta-separator")).toBeNull();
    expect(header.querySelector(".waypoint-topic-description")).toHaveTextContent("仅保留说明");

    // Invalid binding without Description: omits second-line meta container entirely
    rerender(
      <TopicHeaderView
        {...baseProps}
        topic={{ ...sampleTopic, botDisplayName: undefined, description: undefined }}
        descriptionExpanded={false}
      />,
    );
    expect(header.querySelector(".waypoint-topic-header-meta")).toBeNull();
  });
});

describe("TimelineView (#89)", () => {
  const items: TimelineItem[] = [
    { kind: "day-separator", key: "day-1", label: "今天" },
    {
      kind: "message",
      key: "msg-agent",
      eventId: "$agent-1",
      side: "left",
      body: "这是无框文档流回复。",
      status: "confirmed",
      reactions: ["✅"],
      prompt: {
        kind: "approval",
        answered: false,
        superseded: false,
        options: [
          { key: "once", label: "允许一次", scope: "本会话" },
          { key: "deny", label: "拒绝" },
        ],
      },
    },
    {
      kind: "message",
      key: "msg-owner",
      eventId: "$owner-1",
      side: "right",
      body: "请帮我检查。",
      status: "confirmed",
    },
    {
      kind: "message",
      key: "msg-pending",
      localId: "local-pending",
      side: "right",
      body: "发送中",
      status: "unconfirmed",
    },
    {
      kind: "message",
      key: "msg-failed",
      localId: "local-failed",
      side: "right",
      body: "发送失败的消息",
      status: "failed",
    },
  ];

  test("renders unboxed agent document flow, monochrome owner capsule, reactions, prompts, and failed DropdownMenu", async () => {
    const user = userEvent.setup();
    const onToggleFailedMenu = vi.fn();
    const onOpenFailedMenu = vi.fn();
    const onDiscardFailed = vi.fn();
    const onResendFailed = vi.fn();
    const onSelectPromptOption = vi.fn();

    const { rerender } = render(
      <TimelineView
        timelineRef={createRef()}
        items={items}
        responding={true}
        activeTopicUnavailable={false}
        reauthRequired={false}
        openFailedMenuId={null}
        getLocalImageUrl={() => ""}
        getDownloadedImageUrl={() => undefined}
        onScroll={vi.fn()}
        onToggleFailedMenu={onToggleFailedMenu}
        onOpenFailedMenu={onOpenFailedMenu}
        onResendFailed={onResendFailed}
        onDiscardFailed={onDiscardFailed}
        onOpenMedia={vi.fn()}
        onOpenExternalUrl={vi.fn()}
        onSelectPromptOption={onSelectPromptOption}
      />,
    );

    const separator = screen.getByRole("separator", { name: "今天" });
    expect(separator).not.toHaveAttribute("data-side");
    expect(separator).not.toHaveClass("waypoint-message-row");
    expect(separator.querySelector(".waypoint-bubble")).toBeNull();

    const timeline = screen.getByRole("log", { name: "对话时间线" });
    expect(timeline).toHaveClass("overflow-x-hidden", "overflow-y-auto");
    expect(timeline).not.toHaveClass("max-w-3xl", "mx-auto");

    const track = timeline.querySelector(".waypoint-timeline-track") as HTMLElement;
    expect(track).not.toBeNull();
    expect(track).toHaveClass("mx-auto", "w-full", "max-w-3xl");
    expect(track).toContainElement(separator);

    const agentRow = track.querySelector('[data-event-id="$agent-1"]') as HTMLElement;
    expect(agentRow).toHaveAttribute("data-side", "left");
    const agentBubble = agentRow.querySelector(".waypoint-bubble") as HTMLElement;
    expect(agentBubble).toHaveClass(
      "bg-transparent",
      "border-0",
      "shadow-none",
      "max-w-full",
      "leading-[1.5]",
      "text-[16px]",
    );
    expect(agentBubble).not.toHaveClass("max-w-[min(42rem,100%)]");

    const ownerRow = track.querySelector('[data-event-id="$owner-1"]') as HTMLElement;
    expect(ownerRow).toHaveAttribute("data-side", "right");
    const ownerContent = ownerRow.querySelector(".waypoint-message-content") as HTMLElement;
    expect(ownerContent).toHaveClass("max-w-[min(38rem,85%)]");
    const ownerBubble = ownerRow.querySelector(".waypoint-bubble") as HTMLElement;
    expect(ownerBubble).toHaveClass(
      "bg-primary",
      "text-primary-foreground",
      "dark:bg-secondary",
      "dark:text-foreground",
      "rounded-2xl",
      "px-4",
      "py-2.5",
      "text-[16px]",
    );

    expect(screen.queryByRole("status", { name: "未确认" })).not.toBeInTheDocument();
    expect(timeline.querySelector(".waypoint-unconfirmed-spinner")).toBeNull();
    expect(timeline.querySelector(".waypoint-message-reaction")).toHaveTextContent("✅");
    expect(agentRow).not.toHaveTextContent("正在回应");
    expect(screen.queryByText("正在回应")).not.toBeInTheDocument();
    const respondingStatus = within(track).getByRole("status", { name: "正在回应" });
    expect(respondingStatus).toHaveClass("waypoint-timeline-responding", "self-start");
    expect(respondingStatus.closest(".waypoint-bubble")).toBeNull();
    expect(respondingStatus.closest(".waypoint-message-row")).toBeNull();
    expect(respondingStatus.querySelectorAll(".waypoint-responding-dot")).toHaveLength(3);
    expect(track.lastElementChild).toBe(respondingStatus);

    const promptGroup = screen.getByRole("group", { name: "审批操作" });
    await user.click(within(promptGroup).getByRole("button", { name: /允许一次/ }));
    expect(onSelectPromptOption).toHaveBeenCalledWith("$agent-1", "once");

    const failedBubble = screen.getByText("发送失败的消息").closest(".waypoint-bubble") as HTMLElement;
    const failedRow = failedBubble.closest(".waypoint-message-row") as HTMLElement;
    const failedContent = failedBubble.closest(".waypoint-message-content") as HTMLElement;
    const failedControls = failedContent.querySelector(".waypoint-failed-controls") as HTMLElement;
    expect(failedControls).not.toBeNull();
    expect(failedRow.firstElementChild).toBe(failedContent);
    expect(failedBubble.nextElementSibling).toBe(failedControls);
    expect(within(failedControls).getByRole("button", { name: "失败" })).toBeInTheDocument();

    fireEvent.contextMenu(screen.getByText("发送失败的消息"));
    expect(onOpenFailedMenu).toHaveBeenCalledWith("local-failed");

    const failedTrigger = within(failedControls).getByRole("button", { name: "更多操作" });
    await user.click(failedTrigger);
    expect(onToggleFailedMenu).toHaveBeenCalledWith("local-failed");

    rerender(
      <TimelineView
        timelineRef={createRef()}
        items={items}
        responding={false}
        activeTopicUnavailable={false}
        reauthRequired={false}
        openFailedMenuId="local-failed"
        getLocalImageUrl={() => ""}
        getDownloadedImageUrl={() => undefined}
        onScroll={vi.fn()}
        onToggleFailedMenu={onToggleFailedMenu}
        onOpenFailedMenu={onOpenFailedMenu}
        onResendFailed={onResendFailed}
        onDiscardFailed={onDiscardFailed}
        onOpenMedia={vi.fn()}
        onOpenExternalUrl={vi.fn()}
        onSelectPromptOption={onSelectPromptOption}
      />,
    );

    expect(within(track).queryByRole("status", { name: "正在回应" })).not.toBeInTheDocument();

    const failedMenu = screen.getByRole("menu", { name: "消息操作" });
    expect(failedMenu).toHaveAttribute("data-slot", "dropdown-menu-content");
    const discardItem = within(failedMenu).getByRole("menuitem", { name: "丢掉" });
    await user.click(discardItem);
    expect(onDiscardFailed).toHaveBeenCalledWith("local-failed");
  });

  test("disables horizontal timeline scroll and constrains message rows, bubbles, and media filenames (#145)", () => {
    const mediaAndLongTokens: TimelineItem[] = [
      {
        kind: "message",
        key: "msg-agent-long",
        eventId: "$agent-long",
        side: "left",
        body: [
          "# 标题 `hermes-agent/plugins/platforms/matrix/adapter_hint.py`",
          "",
          "- `hermes-agent/plugins/platforms/matrix/adapter_hint.py`",
          "  - `nested_long_unbroken_identifier_without_any_whitespace_1234567890`",
          "",
          "> 引用 `hermes-agent/plugins/platforms/matrix/adapter_hint.py`",
          "",
          "> [!NOTE]",
          "> Callout `hermes-agent/plugins/platforms/matrix/adapter_hint.py`",
        ].join("\n"),
        status: "confirmed",
      },
      {
        kind: "message",
        key: "msg-owner-long",
        eventId: "$owner-long",
        side: "right",
        body: "`hermes-agent/plugins/platforms/matrix/adapter_hint.py`",
        status: "confirmed",
      },
      {
        kind: "message",
        key: "msg-media-long",
        eventId: "$media-long",
        side: "right",
        body: "",
        status: "confirmed",
        media: {
          kind: "file",
          msgtype: "m.file",
          filename: "very_long_unbroken_attachment_filename_without_spaces_1234567890.tar.gz",
          mxcUrl: "mxc://example.com/file1",
        },
      },
      {
        kind: "message",
        key: "msg-image-fallback-long",
        eventId: "$image-fallback-long",
        side: "left",
        body: "",
        status: "confirmed",
        media: {
          kind: "image",
          msgtype: "m.image",
          filename: "very_long_unbroken_image_filename_without_spaces_1234567890.png",
          mxcUrl: "mxc://example.com/img1",
        },
      },
    ];

    render(
      <TimelineView
        timelineRef={createRef()}
        items={mediaAndLongTokens}
        isNarrow
        activeTopicUnavailable={false}
        reauthRequired={false}
        openFailedMenuId={null}
        getLocalImageUrl={() => ""}
        getDownloadedImageUrl={() => undefined}
        onScroll={vi.fn()}
        onToggleFailedMenu={vi.fn()}
        onOpenFailedMenu={vi.fn()}
        onResendFailed={vi.fn()}
        onDiscardFailed={vi.fn()}
        onOpenMedia={vi.fn()}
        onOpenExternalUrl={vi.fn()}
        onSelectPromptOption={vi.fn()}
      />,
    );

    const timeline = screen.getByRole("log", { name: "对话时间线" });
    expect(timeline).toHaveClass("overflow-x-hidden", "overflow-y-auto");
    expect(timeline).not.toHaveClass("max-w-3xl", "mx-auto");

    const track = timeline.querySelector(".waypoint-timeline-track") as HTMLElement;
    expect(track).not.toBeNull();
    expect(track).toHaveClass("mx-auto", "w-full", "min-w-0", "max-w-3xl");

    const agentRow = track.querySelector('[data-event-id="$agent-long"]') as HTMLElement;
    expect(agentRow).toHaveClass("min-w-0", "max-w-full");
    const agentBubble = agentRow.querySelector(".waypoint-bubble") as HTMLElement;
    expect(agentBubble).toHaveClass("min-w-0", "max-w-full", "wrap-anywhere");
    expect(agentBubble).not.toHaveClass("max-w-[min(42rem,100%)]");
    expect(agentBubble.querySelector('[data-streamdown="heading-1"]')).not.toBeNull();
    expect(agentBubble.querySelectorAll('[data-streamdown="list-item"]')).toHaveLength(2);
    expect(agentBubble.querySelector('[data-streamdown="blockquote"]')).not.toBeNull();
    expect(agentBubble.querySelector(".waypoint-callout")).not.toBeNull();
    expect(agentBubble.querySelectorAll('[data-streamdown="inline-code"]')).toHaveLength(5);

    const ownerRow = timeline.querySelector('[data-event-id="$owner-long"]') as HTMLElement;
    expect(ownerRow).toHaveClass("min-w-0", "max-w-full");
    const ownerContent = ownerRow.querySelector(".waypoint-message-content") as HTMLElement;
    expect(ownerContent).toHaveClass("min-w-0", "max-w-[min(38rem,85%)]");
    const ownerBubble = ownerRow.querySelector(".waypoint-bubble") as HTMLElement;
    expect(ownerBubble).toHaveClass("min-w-0", "max-w-full", "wrap-anywhere");

    const mediaRow = timeline.querySelector('[data-event-id="$media-long"]') as HTMLElement;
    const mediaBubble = mediaRow.querySelector(".waypoint-media-bubble") as HTMLElement;
    const mediaBtn = mediaRow.querySelector(".waypoint-media-file-button") as HTMLElement;
    const mediaFilename = mediaRow.querySelector(".waypoint-media-filename") as HTMLElement;
    expect(mediaBubble).toHaveClass("min-w-0", "max-w-full");
    expect(mediaBtn).toHaveClass("min-w-0", "max-w-full");
    expect(mediaFilename).toHaveClass("min-w-0", "max-w-full", "wrap-anywhere");

    const imgRow = timeline.querySelector('[data-event-id="$image-fallback-long"]') as HTMLElement;
    const imgBtn = imgRow.querySelector(".waypoint-media-image-button") as HTMLElement;
    const imgFilename = imgRow.querySelector(".waypoint-media-filename") as HTMLElement;
    expect(imgBtn).toHaveClass("min-w-0", "max-w-full");
    expect(imgFilename).toHaveClass("block", "min-w-0", "max-w-full", "wrap-anywhere");
  });

  test("narrow TimelineView opens long-press message context menu with copy actions (ADR-0028)", async () => {
    render(
      <TimelineView
        timelineRef={createRef()}
        items={items}
        isNarrow={true}
        activeTopicUnavailable={false}
        reauthRequired={false}
        openFailedMenuId={null}
        getLocalImageUrl={() => ""}
        getDownloadedImageUrl={() => undefined}
        onScroll={vi.fn()}
        onToggleFailedMenu={vi.fn()}
        onOpenFailedMenu={vi.fn()}
        onResendFailed={vi.fn()}
        onDiscardFailed={vi.fn()}
        onOpenMedia={vi.fn()}
        onOpenExternalUrl={vi.fn()}
        onSelectPromptOption={vi.fn()}
      />,
    );

    // Long-press (500ms touch-hold) on confirmed agent message in narrow viewport (ADR-0028)
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const agentMsg = screen.getByText("这是无框文档流回复。");
      fireEvent.touchStart(agentMsg, { touches: [{ clientX: 100, clientY: 100 }] });
      act(() => {
        vi.advanceTimersByTime(550);
      });

      const contextDialog = screen.getByRole("dialog", { name: "消息操作" });
      expect(contextDialog).toBeInTheDocument();

      const copyTextItem = within(contextDialog).getByRole("menuitem", { name: "复制纯文本" });
      const copyMdItem = within(contextDialog).getByRole("menuitem", { name: "复制 Markdown" });
      expect(copyTextItem).toBeInTheDocument();
      expect(copyMdItem).toBeInTheDocument();

      fireEvent.click(copyTextItem);
      expect(screen.queryByRole("dialog", { name: "消息操作" })).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  test("long-press copies rendered plain text vs Markdown, scopes code copy to fenced code blocks, skips empty media bubbles, and emits feedback", async () => {
    const originalClipboard = navigator.clipboard;
    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: writeTextMock },
    });

    const onCopyFeedback = vi.fn();
    const richItems: TimelineItem[] = [
      {
        kind: "message",
        key: "rich-1",
        eventId: "$rich-1",
        side: "left",
        status: "confirmed",
        body: "## 小节标题\n\n**加粗** 与 [链接](https://example.com) 及 `inline_var`\n\n> 引用文本\n\n| 列A | 列B |\n| --- | --- |\n| 1 | 2 |\n\n```ts\nconst x = 1;\n```",
      },
      {
        kind: "message",
        key: "media-empty",
        eventId: "$media-empty",
        side: "right",
        status: "confirmed",
        body: "",
        media: {
          kind: "image",
          msgtype: "m.image",
          filename: "photo.png",
          mxcUrl: "mxc://example.com/photo",
        },
      },
    ];

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      render(
        <TimelineView
          timelineRef={createRef()}
          items={richItems}
          isNarrow={true}
          activeTopicUnavailable={false}
          reauthRequired={false}
          openFailedMenuId={null}
          getLocalImageUrl={() => ""}
          getDownloadedImageUrl={() => "blob:photo"}
          onScroll={vi.fn()}
          onToggleFailedMenu={vi.fn()}
          onOpenFailedMenu={vi.fn()}
          onResendFailed={vi.fn()}
          onDiscardFailed={vi.fn()}
          onOpenMedia={vi.fn()}
          onOpenExternalUrl={vi.fn()}
          onSelectPromptOption={vi.fn()}
          onCopyFeedback={onCopyFeedback}
        />,
      );

      // 1. Empty media-only bubble should not open ActionSheet on long-press
      const imgBtn = screen.getByRole("button", { name: "查看图片 photo.png" });
      fireEvent.touchStart(imgBtn, { touches: [{ clientX: 50, clientY: 50 }] });
      act(() => {
        vi.advanceTimersByTime(550);
      });
      expect(screen.queryByRole("dialog", { name: "消息操作" })).not.toBeInTheDocument();

      // 2. Non-code Streamdown elements (inline code, heading, blockquote, table, code-block header) must NOT show 复制代码
      const nonCodeTargets = [
        screen.getByText("inline_var"),
        screen.getByText("小节标题"),
        screen.getByText("引用文本"),
        screen.getByText("列A"),
        document.querySelector('[data-streamdown="code-block-header"]') as HTMLElement,
      ];

      for (const target of nonCodeTargets) {
        expect(target).toBeTruthy();
        fireEvent.touchStart(target, { touches: [{ clientX: 50, clientY: 50 }] });
        act(() => {
          vi.advanceTimersByTime(550);
        });
        const dialog = screen.getByRole("dialog", { name: "消息操作" });
        expect(within(dialog).queryByRole("menuitem", { name: "复制代码" })).not.toBeInTheDocument();
        fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
      }

      // 3. Plain text copy vs Markdown copy
      const removeAllRangesSpy = vi.fn();
      vi.spyOn(window, "getSelection").mockReturnValue({
        removeAllRanges: removeAllRangesSpy,
      } as unknown as Selection);

      const boldEl = screen.getByText("加粗");
      fireEvent.touchStart(boldEl, { touches: [{ clientX: 50, clientY: 50 }] });
      act(() => {
        vi.advanceTimersByTime(550);
      });
      expect(removeAllRangesSpy).toHaveBeenCalled();

      let dialog = screen.getByRole("dialog", { name: "消息操作" });
      fireEvent.click(within(dialog).getByRole("menuitem", { name: "复制纯文本" }));
      await act(async () => {
        await Promise.resolve();
      });
      const copiedPlain = writeTextMock.mock.calls.at(-1)?.[0] as string;
      expect(copiedPlain).toContain("加粗 与 链接 及 inline_var");
      expect(copiedPlain).not.toContain("**");
      expect(copiedPlain).not.toContain("https://example.com");
      expect(copiedPlain).not.toContain("```ts");
      expect(onCopyFeedback).toHaveBeenCalledWith("已复制");

      fireEvent.touchStart(boldEl, { touches: [{ clientX: 50, clientY: 50 }] });
      act(() => {
        vi.advanceTimersByTime(550);
      });
      dialog = screen.getByRole("dialog", { name: "消息操作" });
      fireEvent.click(within(dialog).getByRole("menuitem", { name: "复制 Markdown" }));
      await act(async () => {
        await Promise.resolve();
      });
      expect(writeTextMock.mock.calls.at(-1)?.[0]).toBe((richItems[0] as Extract<TimelineItem, { kind: "message" }>).body);

      // 4. Long-press inside fenced code-block-body shows 复制代码 and copies pure code only
      const codeBody = document.querySelector('[data-streamdown="code-block-body"] code') as HTMLElement;
      expect(codeBody).toBeTruthy();
      fireEvent.touchStart(codeBody, { touches: [{ clientX: 50, clientY: 50 }] });
      act(() => {
        vi.advanceTimersByTime(550);
      });
      dialog = screen.getByRole("dialog", { name: "消息操作" });
      const copyCodeItem = within(dialog).getByRole("menuitem", { name: "复制代码" });
      fireEvent.click(copyCodeItem);
      await act(async () => {
        await Promise.resolve();
      });
      expect((writeTextMock.mock.calls.at(-1)?.[0] as string).trim()).toBe("const x = 1;");
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: originalClipboard,
      });
    }
  });
});

describe("ComposerView (#89)", () => {
  test("renders floating capsule without placeholder, monochrome active send button, FAB, attachment strip, and slash hints", async () => {
    const user = userEvent.setup();
    const onScrollToBottom = vi.fn();
    const onSelectSlashCommand = vi.fn();

    const { rerender } = render(
      <ComposerView
        safeInset={0}
        showScrollBottomFab
        composerMultiline={false}
        composerError="发送失败提示"
        activeTopicUnavailable={false}
        reauthRequired={false}
        persistingSend={false}
        draftAttachmentName="notes.md"
        hasDraftAttachment
        draftText="你好"
        composerFormRef={createRef()}
        composerTextareaRef={createRef()}
        viewportMode="wide"
        supportsFileDropAndPaste
        onScrollToBottom={onScrollToBottom}
        onRemoveAttachment={vi.fn()}
        onSelectSlashCommand={onSelectSlashCommand}
        onSendMessage={vi.fn()}
        onPickedFiles={vi.fn()}
        onFocusTextarea={vi.fn()}
        onDraftTextChange={vi.fn()}
        extractDataTransferFiles={() => []}
      />,
    );

    const safeArea = document.querySelector(".waypoint-composer-safe-area") as HTMLElement;
    expect(safeArea).toHaveAttribute("data-keyboard-inset", "0");
    expect(safeArea).toHaveClass("pointer-events-none");
    expect(safeArea).not.toHaveClass("max-w-3xl", "mx-auto");

    const track = safeArea.querySelector(".waypoint-composer-track") as HTMLElement;
    expect(track).not.toBeNull();
    expect(track).toHaveClass("mx-auto", "w-full", "max-w-3xl", "pointer-events-none");

    const fab = screen.getByRole("button", { name: "回到底部" });
    expect(fab).toHaveClass(
      "waypoint-scroll-bottom-fab",
      "pointer-events-auto",
      "left-1/2",
      "-translate-x-1/2",
    );
    await user.click(fab);
    expect(onScrollToBottom).toHaveBeenCalledTimes(1);

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("发送失败提示");
    expect(track).toContainElement(alert);

    const attachmentRegion = screen.getByRole("region", { name: "已选附件" });
    expect(attachmentRegion).toHaveTextContent("notes.md");
    expect(track).toContainElement(attachmentRegion);

    const formInInitial = document.querySelector("form.waypoint-composer") as HTMLFormElement;
    expect(track).toContainElement(formInInitial);

    const textarea = screen.getByRole("textbox", { name: "输入消息" });
    expect(textarea).not.toHaveAttribute("placeholder");

    const sendBtn = screen.getByRole("button", { name: "发送" });
    expect(sendBtn).toHaveAttribute("data-active", "true");
    expect(sendBtn).toHaveClass("bg-primary", "text-primary-foreground");

    rerender(
      <ComposerView
        safeInset={312}
        showScrollBottomFab
        composerMultiline={false}
        activeTopicUnavailable={false}
        reauthRequired={false}
        persistingSend={false}
        hasDraftAttachment={false}
        draftText=""
        composerFormRef={createRef()}
        composerTextareaRef={createRef()}
        viewportMode="narrow"
        supportsFileDropAndPaste={false}
        onScrollToBottom={onScrollToBottom}
        onRemoveAttachment={vi.fn()}
        onSelectSlashCommand={onSelectSlashCommand}
        onSendMessage={vi.fn()}
        onPickedFiles={vi.fn()}
        onFocusTextarea={vi.fn()}
        onDraftTextChange={vi.fn()}
        extractDataTransferFiles={() => []}
      />,
    );
    expect(screen.queryByRole("button", { name: "回到底部" })).not.toBeInTheDocument();

    rerender(
      <ComposerView
        safeInset={0}
        showScrollBottomFab
        composerMultiline
        activeTopicUnavailable={false}
        reauthRequired={false}
        persistingSend={false}
        hasDraftAttachment={false}
        draftText="/"
        composerFormRef={createRef()}
        composerTextareaRef={createRef()}
        viewportMode="wide"
        supportsFileDropAndPaste
        onScrollToBottom={onScrollToBottom}
        onRemoveAttachment={vi.fn()}
        onSelectSlashCommand={onSelectSlashCommand}
        onSendMessage={vi.fn()}
        onPickedFiles={vi.fn()}
        onFocusTextarea={vi.fn()}
        onDraftTextChange={vi.fn()}
        extractDataTransferFiles={() => []}
      />,
    );

    expect(screen.queryByRole("button", { name: "回到底部" })).not.toBeInTheDocument();
    const form = document.querySelector("form.waypoint-composer") as HTMLFormElement;
    expect(form).toHaveClass("multiline");
    expect(form.className).not.toMatch(/before:(?:h-px|bg-border|border)/);

    const hintRegion = screen.getByRole("region", { name: "斜杠命令提示" });
    expect(track).toContainElement(hintRegion);
    expect(track).toContainElement(form);
    fireEvent.click(within(hintRegion).getByRole("button", { name: "/model" }));
    expect(onSelectSlashCommand).toHaveBeenCalledWith("/model");
  });
  test("applies touch-action and overscroll containment across header, timeline, and composer (#115)", () => {
    const header = render(
      <TopicHeaderView
        isNarrow
        topic={sampleTopic}
        descriptionExpanded={false}
        overflowMenuOpen={false}
        overflowMenuRef={createRef()}
        editing={false}
        editSubmitting={false}
        deleteConfirmOpen={false}
        deleting={false}
        reauthRequired={false}
        pinPending={false}
        onGoBack={vi.fn()}
        onToggleDescription={vi.fn()}
        onToggleOverflowMenu={vi.fn()}
        onCloseOverflowMenu={vi.fn()}
        onTogglePin={vi.fn()}
        onOpenEditForm={vi.fn()}
        onOpenDeleteConfirm={vi.fn()}
      />,
    );
    expect(header.container.querySelector(".waypoint-topic-header")).toHaveClass("touch-none");
    header.unmount();

    const tl = render(
      <TimelineView
        timelineRef={createRef()}
        items={[]}
        activeTopicUnavailable={false}
        reauthRequired={false}
        openFailedMenuId={null}
        isNarrow
        safeInset={300}
        getLocalImageUrl={() => ""}
        getDownloadedImageUrl={() => undefined}
        onScroll={vi.fn()}
        onToggleFailedMenu={vi.fn()}
        onOpenFailedMenu={vi.fn()}
        onResendFailed={vi.fn()}
        onDiscardFailed={vi.fn()}
        onOpenMedia={vi.fn()}
        onOpenExternalUrl={vi.fn()}
        onSelectPromptOption={vi.fn()}
      />,
    );
    expect(tl.container.querySelector(".waypoint-timeline")).toHaveClass("overscroll-contain");
    tl.unmount();

    const compLocked = render(
      <ComposerView
        safeInset={300}
        showScrollBottomFab={false}
        composerMultiline={false}
        composerTextareaScrollable={false}
        activeTopicUnavailable={false}
        reauthRequired={false}
        persistingSend={false}
        hasDraftAttachment={false}
        draftText="hello"
        composerFormRef={createRef()}
        composerTextareaRef={createRef()}
        viewportMode="narrow"
        supportsFileDropAndPaste={false}
        onScrollToBottom={vi.fn()}
        onRemoveAttachment={vi.fn()}
        onSelectSlashCommand={vi.fn()}
        onSendMessage={vi.fn()}
        onPickedFiles={vi.fn()}
        onFocusTextarea={vi.fn()}
        onDraftTextChange={vi.fn()}
        extractDataTransferFiles={() => []}
      />,
    );
    expect(compLocked.container.querySelector(".waypoint-composer-safe-area")).toHaveClass("touch-none");
    expect(compLocked.container.querySelector("form.waypoint-composer")).toHaveClass("touch-none");
    expect(compLocked.getByRole("textbox", { name: "输入消息" })).toHaveClass("touch-none", "overscroll-contain");

    compLocked.rerender(
      <ComposerView
        safeInset={300}
        showScrollBottomFab={false}
        composerMultiline
        composerTextareaScrollable
        activeTopicUnavailable={false}
        reauthRequired={false}
        persistingSend={false}
        hasDraftAttachment={false}
        draftText={"1\n2\n3\n4\n5\n6"}
        composerFormRef={createRef()}
        composerTextareaRef={createRef()}
        viewportMode="narrow"
        supportsFileDropAndPaste={false}
        onScrollToBottom={vi.fn()}
        onRemoveAttachment={vi.fn()}
        onSelectSlashCommand={vi.fn()}
        onSendMessage={vi.fn()}
        onPickedFiles={vi.fn()}
        onFocusTextarea={vi.fn()}
        onDraftTextChange={vi.fn()}
        extractDataTransferFiles={() => []}
      />,
    );
    expect(compLocked.container.querySelector(".waypoint-composer-safe-area")).toHaveClass("touch-pan-y");
    expect(compLocked.container.querySelector("form.waypoint-composer")).toHaveClass("touch-pan-y");
    expect(compLocked.getByRole("textbox", { name: "输入消息" })).toHaveClass("touch-pan-y", "overscroll-contain");
  });

  test("calls onBlurTextarea when composer textarea blurs (#133)", () => {
    const onBlurTextarea = vi.fn();
    render(
      <ComposerView
        safeInset={0}
        showScrollBottomFab={false}
        composerMultiline={false}
        activeTopicUnavailable={false}
        reauthRequired={false}
        persistingSend={false}
        hasDraftAttachment={false}
        draftText="draft"
        composerFormRef={createRef()}
        composerTextareaRef={createRef()}
        viewportMode="wide"
        supportsFileDropAndPaste={true}
        onScrollToBottom={vi.fn()}
        onRemoveAttachment={vi.fn()}
        onSelectSlashCommand={vi.fn()}
        onSendMessage={vi.fn()}
        onPickedFiles={vi.fn()}
        onFocusTextarea={vi.fn()}
        onBlurTextarea={onBlurTextarea}
        onDraftTextChange={vi.fn()}
        extractDataTransferFiles={() => []}
      />,
    );

    const textarea = screen.getByRole("textbox", { name: "输入消息" });
    fireEvent.blur(textarea);
    expect(onBlurTextarea).toHaveBeenCalledTimes(1);
  });
});

describe("Theme hygiene (#89)", () => {
  test("owned TSX files contain zero hardcoded hex literals and MessageBody renders math errors cleanly", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const rootDir = (globalThis as unknown as { process: { cwd: () => string } }).process.cwd();

    const files = [
      "src/waypoint/workspace/TopicHeaderView.tsx",
      "src/waypoint/workspace/TimelineView.tsx",
      "src/waypoint/workspace/ComposerView.tsx",
      "src/waypoint/workspace/RespondingIndicator.tsx",
      "src/waypoint/MessageBody.tsx",
    ];
    for (const rel of files) {
      const content = readFileSync(resolve(rootDir, rel), "utf-8");
      expect(content, `${rel} should not contain hardcoded hex colors`).not.toMatch(
        /#[0-9a-fA-F]{3,6}\b/,
      );
    }

    const { container } = render(<MessageBody body="$$\invalidcommand$$" />);
    expect(container.textContent).toContain("invalidcommand");
  });
});
