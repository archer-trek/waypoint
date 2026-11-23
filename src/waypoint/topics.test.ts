import { describe, expect, test } from "vitest";
import type { PendingRoomEvent, StoredRoomEvents } from "./session-store";
import { deriveLatestMessagePreview, deriveTopics, formatMessagePreviewText } from "./topics";

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
