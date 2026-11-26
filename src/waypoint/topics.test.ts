import { describe, expect, test } from "vitest";
import type { PendingRoomEvent, StoredRoomEvents } from "./session-store";
import {
  deriveLatestMessagePreview,
  deriveRoomTimelineItems,
  deriveTopics,
  formatMessagePreviewText,
  RESPONDING_INACTIVITY_TIMEOUT_MS,
} from "./topics";

describe("formatMessagePreviewText", () => {
  test("strips markdown, callouts, inline color tags, code fences, and collapses whitespace", () => {
    expect(
      formatMessagePreviewText(
        "### 本周总结\n\n> [!WARNING]\n> **磁盘空间** 只剩 `12%` · 查看 [详情](https://example.com/status)\n\n```ts\nconst ok = true;\n```",
      ),
    ).toBe("本周总结 磁盘空间 只剩 12% · 查看 详情 const ok = true;");

    expect(
      formatMessagePreviewText(
        ':::note\n<span style="color: red">警告</span> 与 <font color="blue">snake_case_name</font>\n:::',
      ),
    ).toBe("警告 与 snake_case_name");

    expect(formatMessagePreviewText("价格是 $100，*斜体* 与 ~~旧值~~")).toBe(
      "价格是 $100，斜体 与 旧值",
    );
  });

  test("falls back to collapsed raw body when syntax stripping leaves empty text", () => {
    expect(formatMessagePreviewText("---")).toBe("---");
  });
});

describe("deriveLatestMessagePreview & deriveTopics", () => {
  const owner = "@alice:example.com";
  const agent = "@bot:example.com";

  function makeRoom(
    timelineEvents: StoredRoomEvents["timelineEvents"],
    overrides: Partial<StoredRoomEvents> = {},
  ): StoredRoomEvents {
    return {
      stateEvents: [
        { type: "m.room.create", state_key: "", origin_server_ts: 1000, content: {} },
        { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: agent } },
        { type: "m.room.name", state_key: "", content: { name: "测试 Topic" } },
        { type: "m.room.topic", state_key: "", content: { topic: "不应回退显示的说明" } },
      ],
      timelineEvents,
      ...overrides,
    };
  }

  test("prefers latest renderable message, applies m.replace, strips streaming cursor, and ignores reactions/redacted", () => {
    const room = makeRoom([
      {
        type: "m.room.message",
        event_id: "$m1",
        sender: agent,
        origin_server_ts: 2000,
        content: { msgtype: "m.text", body: "**初版** 回答 ▉" },
      },
      {
        type: "m.room.message",
        event_id: "$m1-edit",
        sender: agent,
        origin_server_ts: 2500,
        content: {
          msgtype: "m.text",
          body: "* **终版** 回答",
          "m.new_content": { msgtype: "m.text", body: "**终版** 回答 ▉" },
          "m.relates_to": { rel_type: "m.replace", event_id: "$m1" },
        },
      },
      {
        type: "m.room.message",
        event_id: "$m2",
        sender: agent,
        origin_server_ts: 3000,
        content: {},
        unsigned: { redacted_because: { event_id: "$red-1" } },
      },
      {
        type: "m.reaction",
        event_id: "$r1",
        sender: owner,
        origin_server_ts: 3100,
        content: { "m.relates_to": { rel_type: "m.annotation", event_id: "$m1", key: "👍" } },
      },
    ]);

    expect(deriveLatestMessagePreview(room, [], owner, agent)).toBe("终版 回答");
  });

  test("includes unconfirmed/failed placeholders and pendingEvents without sender prefix", () => {
    const room = makeRoom([
      {
        type: "m.room.message",
        event_id: "$m1",
        sender: agent,
        origin_server_ts: 2000,
        content: { msgtype: "m.text", body: "Agent 回复" },
      },
      {
        type: "m.room.message",
        sender: owner,
        content: { msgtype: "m.text", body: "本地失败的消息" },
        waypoint_local: { id: "loc-1", status: "failed", txnId: "txn-1" },
      },
    ]);

    expect(deriveLatestMessagePreview(room, [], owner, agent)).toBe("本地失败的消息");

    const pending: PendingRoomEvent[] = [
      {
        txnId: "txn-2",
        roomId: "!r1:example.com",
        type: "m.room.message",
        sender: owner,
        content: { msgtype: "m.text", body: "刚刚排队的未确认消息" },
      },
    ];
    expect(deriveLatestMessagePreview(room, pending, owner, agent)).toBe("刚刚排队的未确认消息");
  });

  test("formats media messages with Chinese type labels and optional captions/filenames", () => {
    expect(
      deriveLatestMessagePreview(
        makeRoom([
          {
            type: "m.room.message",
            event_id: "$img-1",
            sender: owner,
            origin_server_ts: 2000,
            content: {
              msgtype: "m.image",
              url: "mxc://example.com/1",
              filename: "photo.png",
              body: "photo.png",
            },
          },
        ]),
        [],
        owner,
        agent,
      ),
    ).toBe("[图片]");

    expect(
      deriveLatestMessagePreview(
        makeRoom([
          {
            type: "m.room.message",
            event_id: "$img-2",
            sender: agent,
            origin_server_ts: 2100,
            content: {
              msgtype: "m.image",
              url: "mxc://example.com/2",
              filename: "chart.png",
              body: "**趋势图**",
            },
          },
        ]),
        [],
        owner,
        agent,
      ),
    ).toBe("[图片] 趋势图");

    expect(
      deriveLatestMessagePreview(
        makeRoom([
          {
            type: "m.room.message",
            event_id: "$file-1",
            sender: owner,
            origin_server_ts: 2200,
            content: {
              msgtype: "m.file",
              url: "mxc://example.com/3",
              filename: "report.pdf",
              body: "report.pdf",
            },
          },
        ]),
        [],
        owner,
        agent,
      ),
    ).toBe("[文件] report.pdf");

    expect(
      deriveLatestMessagePreview(
        makeRoom([
          {
            type: "m.room.message",
            event_id: "$file-2",
            sender: owner,
            origin_server_ts: 2250,
            content: {
              msgtype: "m.file",
              url: "mxc://example.com/3b",
              filename: "file",
              body: "附带说明",
            },
          },
        ]),
        [],
        owner,
        agent,
      ),
    ).toBe("[文件] file");

    expect(
      deriveLatestMessagePreview(
        makeRoom([
          {
            type: "m.room.message",
            event_id: "$audio-1",
            sender: agent,
            origin_server_ts: 2300,
            content: {
              msgtype: "m.audio",
              url: "mxc://example.com/4",
              body: "voice.ogg",
            },
          },
        ]),
        [],
        owner,
        agent,
      ),
    ).toBe("[音频] voice.ogg");

    expect(
      deriveLatestMessagePreview(
        makeRoom([
          {
            type: "m.room.message",
            event_id: "$video-1",
            sender: owner,
            origin_server_ts: 2400,
            content: {
              msgtype: "m.video",
              url: "mxc://example.com/5",
              filename: "demo.mp4",
              body: "demo.mp4",
            },
          },
        ]),
        [],
        owner,
        agent,
      ),
    ).toBe("[视频] demo.mp4");
  });

  test("omits preview for empty topics and falls back to coldLatestPreview when hot window has none", () => {
    const emptyRoom = makeRoom([]);
    const coldRoom = makeRoom([], { coldLatestPreview: "冷块里的最后一条消息" });
    const topics = deriveTopics(
      {
        "!empty:example.com": emptyRoom,
        "!cold:example.com": coldRoom,
      },
      [{ userId: agent }],
      owner,
    );

    const byId = new Map(topics.map((t) => [t.roomId, t]));
    expect(byId.get("!empty:example.com")?.lastMessagePreview).toBeUndefined();
    expect(byId.get("!cold:example.com")?.lastMessagePreview).toBe("冷块里的最后一条消息");
  });
});

describe("deriveRoomTimelineItems reaction filtering and no per-message responding (#166)", () => {
  const owner = "@alice:example.com";
  const agent = "@bot:example.com";

  function makeRoom(timelineEvents: StoredRoomEvents["timelineEvents"]): StoredRoomEvents {
    return {
      stateEvents: [
        { type: "m.room.create", state_key: "", origin_server_ts: 1000, content: {} },
        { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: agent } },
        { type: "m.room.name", state_key: "", content: { name: "反应过滤测试" } },
      ],
      timelineEvents,
    };
  }

  test("hides bound-agent ✅/❌ (including \\uFE0F variants) on Owner messages while preserving other reactions, Owner reactions, and Agent prompts/reactions", () => {
    const room = makeRoom([
      {
        type: "m.room.message",
        event_id: "$owner-1",
        sender: owner,
        origin_server_ts: 2000,
        content: { msgtype: "m.text", body: "Owner 消息一" },
      },
      {
        type: "m.reaction",
        event_id: "$eyes-1",
        sender: agent,
        origin_server_ts: 2010,
        content: { "m.relates_to": { rel_type: "m.annotation", event_id: "$owner-1", key: "👀" } },
      },
      {
        type: "m.reaction",
        event_id: "$bot-ok-1",
        sender: agent,
        origin_server_ts: 2020,
        content: { "m.relates_to": { rel_type: "m.annotation", event_id: "$owner-1", key: "✅" } },
      },
      {
        type: "m.reaction",
        event_id: "$bot-ok-fe0f",
        sender: agent,
        origin_server_ts: 2030,
        content: { "m.relates_to": { rel_type: "m.annotation", event_id: "$owner-1", key: "✅\uFE0F" } },
      },
      {
        type: "m.reaction",
        event_id: "$bot-err-fe0f",
        sender: agent,
        origin_server_ts: 2040,
        content: { "m.relates_to": { rel_type: "m.annotation", event_id: "$owner-1", key: "❌\uFE0F" } },
      },
      {
        type: "m.reaction",
        event_id: "$bot-thumbs",
        sender: agent,
        origin_server_ts: 2050,
        content: { "m.relates_to": { rel_type: "m.annotation", event_id: "$owner-1", key: "👍" } },
      },
      {
        type: "m.room.message",
        event_id: "$owner-2",
        sender: owner,
        origin_server_ts: 2100,
        content: { msgtype: "m.text", body: "Owner 消息二" },
      },
      {
        type: "m.reaction",
        event_id: "$owner-self-ok",
        sender: owner,
        origin_server_ts: 2110,
        content: { "m.relates_to": { rel_type: "m.annotation", event_id: "$owner-2", key: "✅" } },
      },
      {
        type: "m.reaction",
        event_id: "$bot-err-plain",
        sender: agent,
        origin_server_ts: 2120,
        content: { "m.relates_to": { rel_type: "m.annotation", event_id: "$owner-2", key: "❌" } },
      },
      {
        type: "m.room.message",
        event_id: "$agent-single",
        sender: agent,
        origin_server_ts: 2200,
        content: { msgtype: "m.text", body: "Agent 单反应消息" },
      },
      {
        type: "m.reaction",
        event_id: "$agent-single-ok",
        sender: agent,
        origin_server_ts: 2210,
        content: { "m.relates_to": { rel_type: "m.annotation", event_id: "$agent-single", key: "✅" } },
      },
      {
        type: "m.room.message",
        event_id: "$agent-approval",
        sender: agent,
        origin_server_ts: 2300,
        content: { msgtype: "m.text", body: "审批提示" },
      },
      {
        type: "m.reaction",
        event_id: "$ap-ok",
        sender: agent,
        origin_server_ts: 2310,
        content: { "m.relates_to": { rel_type: "m.annotation", event_id: "$agent-approval", key: "✅" } },
      },
      {
        type: "m.reaction",
        event_id: "$ap-no",
        sender: agent,
        origin_server_ts: 2320,
        content: { "m.relates_to": { rel_type: "m.annotation", event_id: "$agent-approval", key: "❌" } },
      },
      {
        type: "m.room.message",
        event_id: "$agent-selector",
        sender: agent,
        origin_server_ts: 2400,
        content: { msgtype: "m.text", body: "选择提示" },
      },
      {
        type: "m.reaction",
        event_id: "$sel-1",
        sender: agent,
        origin_server_ts: 2410,
        content: { "m.relates_to": { rel_type: "m.annotation", event_id: "$agent-selector", key: "1️⃣" } },
      },
      {
        type: "m.reaction",
        event_id: "$sel-2",
        sender: agent,
        origin_server_ts: 2420,
        content: { "m.relates_to": { rel_type: "m.annotation", event_id: "$agent-selector", key: "2️⃣" } },
      },
    ]);

    const items = deriveRoomTimelineItems(room, [], owner, agent, 3000);
    const byId = new Map(
      items
        .filter((item): item is Extract<typeof item, { kind: "message" }> => item.kind === "message")
        .map((item) => [item.eventId, item]),
    );

    const owner1 = byId.get("$owner-1")!;
    expect(owner1.reactions).toEqual(["👍"]);
    expect("responding" in owner1).toBe(false);

    const owner2 = byId.get("$owner-2")!;
    expect(owner2.reactions).toEqual(["✅"]);

    const agentSingle = byId.get("$agent-single")!;
    expect(agentSingle.reactions).toEqual(["✅"]);

    const approval = byId.get("$agent-approval")!;
    expect(approval.prompt?.kind).toBe("approval");
    expect(approval.prompt?.options.map((o) => o.label)).toEqual(["仅此次", "拒绝"]);
    expect(approval.reactions).toBeUndefined();

    const selector = byId.get("$agent-selector")!;
    expect(selector.prompt?.kind).toBe("selector");
    expect(selector.prompt?.options.map((o) => o.label)).toEqual(["1", "2"]);
  });
});

describe("deriveTopics self-healing responding rules (#166)", () => {
  const owner = "@alice:example.com";
  const agent = "@bot:example.com";
  const stranger = "@stranger:example.com";

  function makeRoom(
    timelineEvents: StoredRoomEvents["timelineEvents"],
    extraState: StoredRoomEvents["stateEvents"] = [],
    overrides: Partial<StoredRoomEvents> = {},
  ): StoredRoomEvents {
    return {
      stateEvents: [
        { type: "m.room.create", state_key: "", origin_server_ts: 1000, content: {} },
        { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: agent } },
        { type: "m.room.name", state_key: "", content: { name: "自愈测试 Topic" } },
        ...extraState,
      ],
      timelineEvents,
      ...overrides,
    };
  }

  function deriveOne(room: StoredRoomEvents, nowMs: number, syncPaused = false) {
    const [topic] = deriveTopics({ "!r1:example.com": room }, [{ userId: agent }], owner, [], {
      nowMs,
      syncPaused,
    });
    return topic!;
  }

  test("exports 5-minute timeout constant and activates responding with server-time expiry for bound Agent 👀", () => {
    expect(RESPONDING_INACTIVITY_TIMEOUT_MS).toBe(300_000);
    const room = makeRoom([
      {
        type: "m.room.message",
        event_id: "$u1",
        sender: owner,
        origin_server_ts: 10_000,
        content: { msgtype: "m.text", body: "hello" },
      },
      {
        type: "m.reaction",
        event_id: "$eyes-1",
        sender: agent,
        origin_server_ts: 10_500,
        content: { "m.relates_to": { rel_type: "m.annotation", event_id: "$u1", key: "👀" } },
      },
    ]);

    const summary = deriveOne(room, 11_000);
    expect(summary.responding).toBe(true);
    expect(summary.respondingExpiresAtMs).toBe(10_500 + 300_000);
  });

  test("terminates immediately on bound-agent ✅/❌ (including \\uFE0F) or redaction of 👀 or target", () => {
    const withCheckFe0f = makeRoom([
      {
        type: "m.room.message",
        event_id: "$u1",
        sender: owner,
        origin_server_ts: 10_000,
        content: { msgtype: "m.text", body: "u1" },
      },
      {
        type: "m.reaction",
        event_id: "$eyes-1",
        sender: agent,
        origin_server_ts: 10_100,
        content: { "m.relates_to": { rel_type: "m.annotation", event_id: "$u1", key: "👀" } },
      },
      {
        type: "m.reaction",
        event_id: "$done-1",
        sender: agent,
        origin_server_ts: 10_200,
        content: { "m.relates_to": { rel_type: "m.annotation", event_id: "$u1", key: "✅\uFE0F" } },
      },
    ]);
    expect(deriveOne(withCheckFe0f, 10_300).responding).toBe(false);
    expect(deriveOne(withCheckFe0f, 10_300).respondingExpiresAtMs).toBeUndefined();

    const withCrossFe0f = makeRoom([
      {
        type: "m.room.message",
        event_id: "$u1",
        sender: owner,
        origin_server_ts: 10_000,
        content: { msgtype: "m.text", body: "u1" },
      },
      {
        type: "m.reaction",
        event_id: "$eyes-1",
        sender: agent,
        origin_server_ts: 10_100,
        content: { "m.relates_to": { rel_type: "m.annotation", event_id: "$u1", key: "👀" } },
      },
      {
        type: "m.reaction",
        event_id: "$err-1",
        sender: agent,
        origin_server_ts: 10_200,
        content: { "m.relates_to": { rel_type: "m.annotation", event_id: "$u1", key: "❌\uFE0F" } },
      },
    ]);
    expect(deriveOne(withCrossFe0f, 10_300).responding).toBe(false);

    const redactedTargetViaEvent = makeRoom([
      {
        type: "m.room.message",
        event_id: "$u1",
        sender: owner,
        origin_server_ts: 10_000,
        content: { msgtype: "m.text", body: "u1" },
      },
      {
        type: "m.reaction",
        event_id: "$eyes-1",
        sender: agent,
        origin_server_ts: 10_100,
        content: { "m.relates_to": { rel_type: "m.annotation", event_id: "$u1", key: "👀" } },
      },
      {
        type: "m.room.redaction",
        event_id: "$red-u1",
        sender: owner,
        origin_server_ts: 10_200,
        redacts: "$u1",
        content: {},
      },
    ]);
    expect(deriveOne(redactedTargetViaEvent, 10_300).responding).toBe(false);

    const redactedEyesUnsigned = makeRoom([
      {
        type: "m.room.message",
        event_id: "$u1",
        sender: owner,
        origin_server_ts: 10_000,
        content: { msgtype: "m.text", body: "u1" },
      },
      {
        type: "m.reaction",
        event_id: "$eyes-1",
        sender: agent,
        origin_server_ts: 10_100,
        content: { "m.relates_to": { rel_type: "m.annotation", event_id: "$u1", key: "👀" } },
        unsigned: { redacted_because: { event_id: "$red-eyes" } },
      },
    ]);
    expect(deriveOne(redactedEyesUnsigned, 10_300).responding).toBe(false);
  });

  test("ignores 👀 from non-bound senders or on state events or local placeholders", () => {
    const room = makeRoom(
      [
        {
          type: "m.room.message",
          event_id: "$u1",
          sender: owner,
          origin_server_ts: 10_000,
          content: { msgtype: "m.text", body: "u1" },
        },
        {
          type: "m.reaction",
          event_id: "$owner-eyes",
          sender: owner,
          origin_server_ts: 10_100,
          content: { "m.relates_to": { rel_type: "m.annotation", event_id: "$u1", key: "👀" } },
        },
        {
          type: "m.reaction",
          event_id: "$stranger-eyes",
          sender: stranger,
          origin_server_ts: 10_200,
          content: { "m.relates_to": { rel_type: "m.annotation", event_id: "$u1", key: "👀" } },
        },
        {
          type: "m.reaction",
          event_id: "$state-eyes",
          sender: agent,
          origin_server_ts: 10_300,
          content: { "m.relates_to": { rel_type: "m.annotation", event_id: "$state-name", key: "👀" } },
        },
        {
          type: "m.room.message",
          event_id: "$local-u",
          sender: owner,
          content: { msgtype: "m.text", body: "pending" },
          waypoint_local: { id: "loc-1", status: "unconfirmed", txnId: "t1" },
        },
        {
          type: "m.reaction",
          event_id: "$local-eyes",
          sender: agent,
          origin_server_ts: 10_400,
          content: { "m.relates_to": { rel_type: "m.annotation", event_id: "$local-u", key: "👀" } },
        },
      ],
      [{ type: "m.room.name", event_id: "$state-name", state_key: "", content: { name: "Topic" } }],
    );

    expect(deriveOne(room, 10_500).responding).toBe(false);
  });

  test("newer terminated Owner turn invalidates leaked older 👀, while newer active 👀 and agent approval pre-seeds keep responding active", () => {
    const leakedOlderEyes = makeRoom([
      {
        type: "m.room.message",
        event_id: "$u1",
        sender: owner,
        origin_server_ts: 10_000,
        content: { msgtype: "m.text", body: "旧问题" },
      },
      {
        type: "m.reaction",
        event_id: "$eyes-1",
        sender: agent,
        origin_server_ts: 10_100,
        content: { "m.relates_to": { rel_type: "m.annotation", event_id: "$u1", key: "👀" } },
      },
      {
        type: "m.room.message",
        event_id: "$u2",
        sender: owner,
        origin_server_ts: 20_000,
        content: { msgtype: "m.text", body: "新问题" },
      },
      {
        type: "m.reaction",
        event_id: "$done-2",
        sender: agent,
        origin_server_ts: 20_200,
        content: { "m.relates_to": { rel_type: "m.annotation", event_id: "$u2", key: "✅" } },
      },
    ]);
    expect(deriveOne(leakedOlderEyes, 20_500).responding).toBe(false);

    const concurrentAndApproval = makeRoom([
      {
        type: "m.room.message",
        event_id: "$u1",
        sender: owner,
        origin_server_ts: 10_000,
        content: { msgtype: "m.text", body: "问题一" },
      },
      {
        type: "m.reaction",
        event_id: "$eyes-1",
        sender: agent,
        origin_server_ts: 10_100,
        content: { "m.relates_to": { rel_type: "m.annotation", event_id: "$u1", key: "👀" } },
      },
      {
        type: "m.reaction",
        event_id: "$done-1",
        sender: agent,
        origin_server_ts: 10_200,
        content: { "m.relates_to": { rel_type: "m.annotation", event_id: "$u1", key: "✅" } },
      },
      {
        type: "m.room.message",
        event_id: "$u2",
        sender: owner,
        origin_server_ts: 20_000,
        content: { msgtype: "m.text", body: "问题二" },
      },
      {
        type: "m.reaction",
        event_id: "$eyes-2",
        sender: agent,
        origin_server_ts: 20_100,
        content: { "m.relates_to": { rel_type: "m.annotation", event_id: "$u2", key: "👀" } },
      },
      {
        type: "m.room.message",
        event_id: "$agent-ap",
        sender: agent,
        origin_server_ts: 25_000,
        content: { msgtype: "m.text", body: "请审批命令" },
      },
      {
        type: "m.reaction",
        event_id: "$ap-ok",
        sender: agent,
        origin_server_ts: 25_100,
        content: { "m.relates_to": { rel_type: "m.annotation", event_id: "$agent-ap", key: "✅" } },
      },
      {
        type: "m.reaction",
        event_id: "$ap-no",
        sender: agent,
        origin_server_ts: 25_200,
        content: { "m.relates_to": { rel_type: "m.annotation", event_id: "$agent-ap", key: "❌" } },
      },
    ]);
    const active = deriveOne(concurrentAndApproval, 26_000);
    expect(active.responding).toBe(true);
    expect(active.respondingExpiresAtMs).toBe(25_000 + 300_000);
  });

  test("extends 5-minute deadline on agent progress messages and m.replace edits, ignores redacted activity, and enforces exact 300,000ms boundary", () => {
    const room = makeRoom([
      {
        type: "m.room.message",
        event_id: "$u1",
        sender: owner,
        origin_server_ts: 10_000,
        content: { msgtype: "m.text", body: "执行长任务" },
      },
      {
        type: "m.reaction",
        event_id: "$eyes-1",
        sender: agent,
        origin_server_ts: 11_000,
        content: { "m.relates_to": { rel_type: "m.annotation", event_id: "$u1", key: "👀" } },
      },
      {
        type: "m.room.message",
        event_id: "$prog-1",
        sender: agent,
        origin_server_ts: 100_000,
        content: { msgtype: "m.text", body: "进度一 ▉" },
      },
      {
        type: "m.room.message",
        event_id: "$prog-1-edit",
        sender: agent,
        origin_server_ts: 200_000,
        content: {
          msgtype: "m.text",
          body: "* 进度二",
          "m.new_content": { msgtype: "m.text", body: "进度二" },
          "m.relates_to": { rel_type: "m.replace", event_id: "$prog-1" },
        },
      },
      {
        type: "m.room.message",
        event_id: "$prog-redacted",
        sender: agent,
        origin_server_ts: 250_000,
        content: { msgtype: "m.text", body: "被撤回的进度" },
        unsigned: { redacted_because: { event_id: "$red-prog" } },
      },
    ]);

    // Latest unredacted activity is $prog-1-edit at 200_000 -> deadline 500_000
    const justBefore = deriveOne(room, 499_999);
    expect(justBefore.responding).toBe(true);
    expect(justBefore.respondingExpiresAtMs).toBe(500_000);

    // Cross-device consistency: identical origin_server_ts + nowMs gives exact same expiry & convergence
    const repeatCheck = deriveOne(room, 499_999);
    expect(repeatCheck.responding).toBe(justBefore.responding);
    expect(repeatCheck.respondingExpiresAtMs).toBe(justBefore.respondingExpiresAtMs);

    const exactBoundary = deriveOne(room, 500_000);
    expect(exactBoundary.responding).toBe(false);
    expect(exactBoundary.respondingExpiresAtMs).toBeUndefined();
  });

  test("gates responding on room unavailability, invalid binding, syncPaused, and missing timestamps", () => {
    const activeRoom = makeRoom([
      {
        type: "m.room.message",
        event_id: "$u1",
        sender: owner,
        origin_server_ts: 10_000,
        content: { msgtype: "m.text", body: "u1" },
      },
      {
        type: "m.reaction",
        event_id: "$eyes-1",
        sender: agent,
        origin_server_ts: 10_500,
        content: { "m.relates_to": { rel_type: "m.annotation", event_id: "$u1", key: "👀" } },
      },
    ]);
    expect(deriveOne(activeRoom, 11_000, true).responding).toBe(false);

    const encryptedRoom = makeRoom(activeRoom.timelineEvents, [
      { type: "m.room.encryption", state_key: "", content: { algorithm: "m.megolm.v1.aes-sha2" } },
    ]);
    expect(deriveOne(encryptedRoom, 11_000).responding).toBe(false);

    const invalidBindingRoom: StoredRoomEvents = {
      stateEvents: [
        { type: "m.room.create", state_key: "", origin_server_ts: 1000, content: {} },
        { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@other:foreign.org" } },
        { type: "m.room.name", state_key: "", content: { name: "非法绑定" } },
      ],
      timelineEvents: activeRoom.timelineEvents,
    };
    const invalidSummary = deriveOne(invalidBindingRoom, 11_000);
    expect(invalidSummary.unavailable).toBe(true);
    expect(invalidSummary.botDisplayName).toBeUndefined();
    expect(invalidSummary.responding).toBe(false);

    const missingTsRoom = makeRoom([
      {
        type: "m.room.message",
        event_id: "$u1",
        sender: owner,
        content: { msgtype: "m.text", body: "无时间戳" },
      },
      {
        type: "m.reaction",
        event_id: "$eyes-no-ts",
        sender: agent,
        content: { "m.relates_to": { rel_type: "m.annotation", event_id: "$u1", key: "👀" } },
      },
    ]);
    expect(deriveOne(missingTsRoom, 11_000).responding).toBe(false);

    const fallbackTargetTsRoom = makeRoom([
      {
        type: "m.room.message",
        event_id: "$u1",
        sender: owner,
        origin_server_ts: 10_000,
        content: { msgtype: "m.text", body: "目标有时间戳" },
      },
      {
        type: "m.reaction",
        event_id: "$eyes-no-ts",
        sender: agent,
        content: { "m.relates_to": { rel_type: "m.annotation", event_id: "$u1", key: "👀" } },
      },
    ]);
    const fallback = deriveOne(fallbackTargetTsRoom, 11_000);
    expect(fallback.responding).toBe(true);
    expect(fallback.respondingExpiresAtMs).toBe(10_000 + 300_000);
  });
});
