import { createRef, useState } from "react";
import { describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
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
  test("renders sticky translucent header, narrow back button, expandable description, and no bot pills", () => {
    const onGoBack = vi.fn();
    const onToggleDescription = vi.fn();
    render(
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
    expect(header).toHaveClass(
      "waypoint-topic-header",
      "sticky",
      "top-0",
      "bg-background/90",
      "backdrop-blur-md",
      "border-b",
      "border-border/60",
    );
    expect(header).toHaveTextContent("Grokbot 架构讨论");
    expect(header).not.toHaveTextContent("Architect Bot");

    const backBtn = screen.getByRole("button", { name: "返回" });
    expect(backBtn).toHaveAttribute("data-slot", "button");

    const descBtn = screen.getByRole("button", { name: /第一行说明/ });
    expect(descBtn).toHaveClass("waypoint-topic-description");
    expect(descBtn).toHaveAttribute("aria-expanded", "false");
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
      responding: true,
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
    const agentRow = timeline.querySelector('[data-event-id="$agent-1"]') as HTMLElement;
    expect(agentRow).toHaveAttribute("data-side", "left");
    const agentBubble = agentRow.querySelector(".waypoint-bubble") as HTMLElement;
    expect(agentBubble).toHaveClass(
      "bg-transparent",
      "border-0",
      "shadow-none",
      "max-w-[min(42rem,100%)]",
      "leading-[1.65]",
    );

    const ownerRow = timeline.querySelector('[data-event-id="$owner-1"]') as HTMLElement;
    expect(ownerRow).toHaveAttribute("data-side", "right");
    const ownerBubble = ownerRow.querySelector(".waypoint-bubble") as HTMLElement;
    expect(ownerBubble).toHaveClass(
      "bg-primary",
      "text-primary-foreground",
      "dark:bg-secondary",
      "dark:text-foreground",
      "rounded-2xl",
      "px-4",
      "py-2.5",
    );

    expect(screen.getByRole("status", { name: "未确认" })).toBeInTheDocument();
    expect(timeline.querySelector(".waypoint-message-reaction")).toHaveTextContent("✅");
    expect(screen.getByText("正在回应")).toBeInTheDocument();

    const promptGroup = screen.getByRole("group", { name: "审批操作" });
    await user.click(within(promptGroup).getByRole("button", { name: /允许一次/ }));
    expect(onSelectPromptOption).toHaveBeenCalledWith("$agent-1", "once");

    fireEvent.contextMenu(screen.getByText("发送失败的消息"));
    expect(onOpenFailedMenu).toHaveBeenCalledWith("local-failed");

    const failedTrigger = screen.getByRole("button", { name: "更多操作" });
    await user.click(failedTrigger);
    expect(onToggleFailedMenu).toHaveBeenCalledWith("local-failed");

    rerender(
      <TimelineView
        timelineRef={createRef()}
        items={items}
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

    const failedMenu = screen.getByRole("menu", { name: "消息操作" });
    expect(failedMenu).toHaveAttribute("data-slot", "dropdown-menu-content");
    const discardItem = within(failedMenu).getByRole("menuitem", { name: "丢掉" });
    await user.click(discardItem);
    expect(onDiscardFailed).toHaveBeenCalledWith("local-failed");
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

    const fab = screen.getByRole("button", { name: "回到底部" });
    expect(fab).toHaveClass("waypoint-scroll-bottom-fab");
    await user.click(fab);
    expect(onScrollToBottom).toHaveBeenCalledTimes(1);

    expect(screen.getByRole("alert")).toHaveTextContent("发送失败提示");
    expect(screen.getByRole("region", { name: "已选附件" })).toHaveTextContent("notes.md");

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

    const hintRegion = screen.getByRole("region", { name: "斜杠命令提示" });
    fireEvent.click(within(hintRegion).getByRole("button", { name: "/model" }));
    expect(onSelectSlashCommand).toHaveBeenCalledWith("/model");
  });
});

describe("Theme hygiene (#89)", () => {
  test("owned TSX files contain zero hardcoded hex literals and MessageBody renders math errors cleanly", async () => {
    // @ts-expect-error Node.js built-in fs in Vitest test runner
    const { readFileSync } = await import("node:fs");
    // @ts-expect-error Node.js built-in path in Vitest test runner
    const { resolve } = await import("node:path");
    const rootDir = (globalThis as unknown as { process: { cwd: () => string } }).process.cwd();

    const files = [
      "src/waypoint/workspace/TopicHeaderView.tsx",
      "src/waypoint/workspace/TimelineView.tsx",
      "src/waypoint/workspace/ComposerView.tsx",
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
