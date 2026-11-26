import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { loadV2Snapshot, saveSession } from "../session-store";
import {
  advanceWhenTimerScheduled,
  FakeHomeserver,
  login,
  passwordLoginHandler,
  renderApp,
  setupIntegrationTestEnv,
  validAgents,
  withMockedTimelineLayout,
} from "./harness";

setupIntegrationTestEnv();

afterEach(() => {
  vi.restoreAllMocks();
});

test("删除消息（含 Owner 与 Agent 消息）需二次确认、失败原样保留、成功后跨设备无占位移除并同步清理收藏与侧栏预览", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  let syncRound = 0;
  let redactAttempt = 0;
  const favAccountDataPuts: unknown[] = [];

  homeserver.handler = passwordLoginHandler(async (input) => {
    if (input.url.includes("/sync")) {
      syncRound += 1;
      if (syncRound === 1) {
        return {
          type: "response",
          status: 200,
          body: {
            next_batch: "batch-1",
            account_data: validAgents,
            rooms: {
              join: {
                "!t1:example.com": {
                  state: {
                    events: [
                      { type: "m.room.create", state_key: "", origin_server_ts: 1000, content: {} },
                      {
                        type: "im.waypoint.topic",
                        state_key: "",
                        content: { v: 1, agent_user_id: "@bot:example.com" },
                      },
                      { type: "m.room.name", state_key: "", content: { name: "删除与收藏测试" } },
                    ],
                  },
                  timeline: {
                    events: [
                      {
                        type: "m.room.message",
                        event_id: "$o1",
                        sender: "@alice:example.com",
                        origin_server_ts: 1500,
                        content: { msgtype: "m.text", body: "Owner 的提问" },
                      },
                      {
                        type: "m.room.message",
                        event_id: "$a1",
                        sender: "@bot:example.com",
                        origin_server_ts: 2500,
                        content: { msgtype: "m.text", body: "Agent 的最新回答" },
                      },
                    ],
                  },
                },
              },
            },
          },
        };
      }
      return {
        type: "response",
        status: 200,
        body: { next_batch: `batch-${syncRound}` },
      };
    }

    if (input.method === "PUT" && input.url.includes("/account_data/im.waypoint.favorites")) {
      favAccountDataPuts.push(input.body);
      return { type: "response", status: 200, body: {} };
    }

    if (input.method === "PUT" && input.url.includes("/redact/")) {
      redactAttempt += 1;
      if (redactAttempt === 1) {
        return {
          type: "response",
          status: 403,
          body: { errcode: "M_FORBIDDEN", error: "RAW_FORBIDDEN_CANARY" },
        };
      }
      return {
        type: "response",
        status: 200,
        body: { event_id: `$red-${redactAttempt}` },
      };
    }

    throw new Error(`不应发送 ${input.method} ${input.url}`);
  });

  renderApp(homeserver, "Waypoint macOS", { viewportMode: () => "wide" });
  await login(user);

  const topicBtn = await screen.findByRole("button", { name: /删除与收藏测试/ });
  expect(topicBtn).toHaveTextContent("Agent 的最新回答");
  await user.click(topicBtn);

  // 0 收藏时顶栏不出现收藏入口
  expect(screen.queryByRole("button", { name: /^收藏/ })).not.toBeInTheDocument();

  const timeline = screen.getByRole("log", { name: "对话时间线" });

  // 先收藏 Agent 消息（绝不发送 m.room.pinned_events）
  fireEvent.contextMenu(within(timeline).getByText("Agent 的最新回答"));
  await user.click(await screen.findByRole("menuitem", { name: "收藏" }));
  await waitFor(() => {
    expect(screen.getByRole("button", { name: "收藏 (1)" })).toBeInTheDocument();
  });
  expect(homeserver.requests.some((r) => r.url.includes("m.room.pinned_events"))).toBe(false);
  expect(favAccountDataPuts).toHaveLength(1);

  // 尝试删除 Agent 消息：先点取消，不发请求
  fireEvent.contextMenu(within(timeline).getByText("Agent 的最新回答"));
  await user.click(await screen.findByRole("menuitem", { name: "删除消息" }));
  const cancelDialog = await screen.findByRole("alertdialog", { name: "确认删除这条消息？" });
  await user.click(within(cancelDialog).getByRole("button", { name: "取消" }));
  expect(homeserver.requests.some((r) => r.url.includes("/redact/"))).toBe(false);

  // 再次点删除消息并确认 -> 第一次 403 失败：消息原样保留且不泄漏原始英文错误
  fireEvent.contextMenu(within(timeline).getByText("Agent 的最新回答"));
  await user.click(await screen.findByRole("menuitem", { name: "删除消息" }));
  const failDialog = await screen.findByRole("alertdialog", { name: "确认删除这条消息？" });
  await user.click(within(failDialog).getByRole("button", { name: "确认删除" }));
  await waitFor(() => {
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });
  expect(within(timeline).getByText("Agent 的最新回答")).toBeInTheDocument();
  expect(screen.getByRole("status")).not.toHaveTextContent("RAW_FORBIDDEN_CANARY");

  // 再次确认删除 -> 200 成功：气泡消失且不留占位，收藏同步移除，侧栏预览回退到 Owner 的提问
  fireEvent.contextMenu(within(timeline).getByText("Agent 的最新回答"));
  await user.click(await screen.findByRole("menuitem", { name: "删除消息" }));
  const okDialog = await screen.findByRole("alertdialog", { name: "确认删除这条消息？" });
  await user.click(within(okDialog).getByRole("button", { name: "确认删除" }));

  await waitFor(() => {
    expect(within(timeline).queryByText("Agent 的最新回答")).not.toBeInTheDocument();
  });
  expect(within(timeline).queryByText(/已撤回|已删除/)).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /^收藏/ })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: /删除与收藏测试/ })).toHaveTextContent("Owner 的提问");

  // 也可以删 Owner 自己的消息
  fireEvent.contextMenu(within(timeline).getByText("Owner 的提问"));
  await user.click(await screen.findByRole("menuitem", { name: "删除消息" }));
  const ownerDialog = await screen.findByRole("alertdialog", { name: "确认删除这条消息？" });
  await user.click(within(ownerDialog).getByRole("button", { name: "确认删除" }));
  await waitFor(() => {
    expect(within(timeline).queryByText("Owner 的提问")).not.toBeInTheDocument();
  });
});

test("收藏列表支持冷分块跳转高亮、直接取消收藏、失败回滚，且不可用 Topic 允许收藏但禁用删除消息", async () => {
  await withMockedTimelineLayout(60, 600, async () => {
    const user = userEvent.setup();
    const homeserver = new FakeHomeserver();
    let failNextFav = true;

    const coldAndHotEvents = Array.from({ length: 80 }, (_, i) => ({
      type: "m.room.message",
      event_id: `$m-${i}`,
      sender: i % 2 === 0 ? "@alice:example.com" : "@bot:example.com",
      origin_server_ts: 1000 + i * 100,
      content: { msgtype: "m.text", body: `第 ${i} 条消息` },
    }));

    await saveSession({
      baseUrl: "https://matrix.example.com",
      userId: "@alice:example.com",
      accessToken: "tok-1",
      deviceId: "DEV1",
      syncCursor: "batch-1",
      accountData: { "im.waypoint.agents": { agents: [{ user_id: "@bot:example.com" }] } },
      rooms: {
        "!cold:example.com": {
          stateEvents: [
            { type: "m.room.create", state_key: "", origin_server_ts: 1000, content: {} },
            {
              type: "im.waypoint.topic",
              state_key: "",
              content: { v: 1, agent_user_id: "@bot:example.com" },
            },
            { type: "m.room.name", state_key: "", content: { name: "冷块收藏话题" } },
          ],
          timelineEvents: coldAndHotEvents,
          favorites: [
            {
              eventId: "$m-5",
              favoritedAt: 100,
              senderSide: "left",
              preview: "第 5 条消息",
              ts: 1500,
            },
            {
              eventId: "$m-78",
              favoritedAt: 200,
              senderSide: "right",
              preview: "第 78 条消息",
              ts: 8800,
            },
          ],
        },
        "!unavail:example.com": {
          stateEvents: [
            { type: "m.room.create", state_key: "", origin_server_ts: 1000, content: {} },
            {
              type: "im.waypoint.topic",
              state_key: "",
              content: { v: 1, agent_user_id: "@bot:example.com" },
            },
            { type: "m.room.name", state_key: "", content: { name: "不可用话题" } },
            { type: "m.room.encryption", state_key: "", content: { algorithm: "m.megolm.v1.aes-sha2" } },
          ],
          timelineEvents: [
            {
              type: "m.room.message",
              event_id: "$u-1",
              sender: "@bot:example.com",
              origin_server_ts: 1000,
              content: { msgtype: "m.text", body: "不可用话题里的历史回复" },
            },
          ],
        },
      },
    });

    homeserver.handler = async (input) => {
      if (input.url.includes("/sync")) {
        return { type: "response", status: 200, body: { next_batch: "batch-2" } };
      }
      if (input.method === "PUT" && input.url.includes("/account_data/im.waypoint.favorites")) {
        if (failNextFav) {
          failNextFav = false;
          return { type: "failure", failure: { type: "network" } };
        }
        return { type: "response", status: 200, body: {} };
      }
      throw new Error(`不应发送 ${input.method} ${input.url}`);
    };

    renderApp(homeserver, "Waypoint macOS", { viewportMode: () => "wide" });

    await user.click(await screen.findByRole("button", { name: /冷块收藏话题/ }));

    // 初始热窗口不含 $m-5，但顶栏仍显示 2 条收藏
    const timeline = screen.getByRole("log", { name: "对话时间线" });
    expect(within(timeline).queryByText("第 5 条消息")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "收藏 (2)" }));
    const favDialog = await screen.findByRole("dialog", { name: "收藏（2）" });
    // 倒序展示：$m-78 在前，$m-5 在后
    const jumpButtons = favDialog.querySelectorAll(".waypoint-favorite-jump");
    expect(jumpButtons[0]).toHaveTextContent("第 78 条消息");
    expect(jumpButtons[1]).toHaveTextContent("第 5 条消息");

    // 取消收藏失败时回滚，仍保持 2 条
    const removeBtns = within(favDialog).getAllByRole("button", { name: "取消收藏" });
    await user.click(removeBtns[0]!);
    await waitFor(() => {
      expect(screen.getByRole("dialog", { name: "收藏（2）" })).toBeInTheDocument();
    });

    // 再点一次成功取消 $m-78，数量变为 1
    await user.click(within(favDialog).getAllByRole("button", { name: "取消收藏" })[0]!);
    await waitFor(() => {
      expect(screen.getByRole("dialog", { name: "收藏（1）" })).toBeInTheDocument();
    });

    // 点击冷块收藏 $m-5 -> 关闭列表、加载冷块并定位高亮
    await user.click(within(screen.getByRole("dialog", { name: "收藏（1）" })).getByText("第 5 条消息"));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      const targetRow = timeline.querySelector('[data-event-id="$m-5"]') as HTMLElement | null;
      expect(targetRow).not.toBeNull();
      expect(targetRow).toHaveAttribute("data-highlighted", "true");
    });

    // 切到不可用 Topic：可收藏，但禁用删除消息
    await user.click(screen.getByRole("button", { name: /不可用话题/ }));
    const unavailTimeline = screen.getByRole("log", { name: "对话时间线" });
    fireEvent.contextMenu(within(unavailTimeline).getByText("不可用话题里的历史回复"));
    const menu = await screen.findByRole("menu", { name: "消息操作" });
    expect(within(menu).getByRole("menuitem", { name: "删除消息" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await user.click(within(menu).getByRole("menuitem", { name: "收藏" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "收藏 (1)" })).toBeInTheDocument();
    });

    // 确认持久化到 IndexedDB
    const snapshot = await loadV2Snapshot();
    expect(snapshot.rooms["!unavail:example.com"]?.favorites?.map((f) => f.eventId)).toEqual([
      "$u-1",
    ]);
  });
});

test("移动端长按无说明图片可收藏，支持从服务器历史页拉取跳回，跨设备同步撤回自动清收藏且删除 Topic 一并清除", async () => {
  await withMockedTimelineLayout(60, 600, async () => {
    const user = userEvent.setup();
    const homeserver = new FakeHomeserver();
    let syncRound = 0;

    homeserver.handler = passwordLoginHandler(async (input) => {
      if (input.url.includes("/sync")) {
        syncRound += 1;
        if (syncRound === 1) {
          return {
            type: "response",
            status: 200,
            body: {
              next_batch: "batch-1",
              account_data: validAgents,
              rooms: {
                join: {
                  "!t1:example.com": {
                    state: {
                      events: [
                        { type: "m.room.create", state_key: "", origin_server_ts: 1000, content: {} },
                        {
                          type: "im.waypoint.topic",
                          state_key: "",
                          content: { v: 1, agent_user_id: "@bot:example.com" },
                        },
                        { type: "m.room.name", state_key: "", content: { name: "移动端与回源跳转" } },
                      ],
                    },
                    timeline: {
                      limited: true,
                      prev_batch: "prev-1",
                      events: [
                        {
                          type: "m.room.message",
                          event_id: "$img-1",
                          sender: "@bot:example.com",
                          origin_server_ts: 5000,
                          content: {
                            msgtype: "m.image",
                            body: "chart.png",
                            url: "mxc://example.com/chart",
                          },
                        },
                      ],
                    },
                    account_data: {
                      events: [
                        {
                          type: "im.waypoint.favorites",
                          content: {
                            v: 1,
                            favorites: [
                              {
                                eventId: "$old-remote",
                                favoritedAt: 100,
                                senderSide: "left",
                                preview: "远端旧消息",
                                ts: 1000,
                              },
                            ],
                          },
                        },
                      ],
                    },
                  },
                },
              },
            },
          };
        }
        return {
          type: "response",
          status: 200,
          body: {
            next_batch: `batch-${syncRound}`,
            rooms: {
              join: {
                "!t1:example.com": {
                  timeline: {
                    events: [
                      {
                        type: "m.room.redaction",
                        event_id: "$red-remote",
                        redacts: "$old-remote",
                        sender: "@alice:example.com",
                      },
                    ],
                  },
                },
              },
            },
          },
        };
      }

      if (input.method === "GET" && input.url.includes("/_matrix/media/v3/download/")) {
        return { type: "response", status: 200, body: new Uint8Array([1, 2, 3]) };
      }
      if (input.method === "GET" && input.url.includes("/messages")) {
        return {
          type: "response",
          status: 200,
          body: {
            chunk: [
              {
                type: "m.room.message",
                event_id: "$old-remote",
                sender: "@bot:example.com",
                origin_server_ts: 1000,
                content: { msgtype: "m.text", body: "远端旧消息" },
              },
            ],
            end: "",
          },
        };
      }
      if (input.method === "PUT" && input.url.includes("/account_data/im.waypoint.favorites")) {
        return { type: "response", status: 200, body: {} };
      }
      if (input.method === "POST" && (input.url.includes("/leave") || input.url.includes("/forget"))) {
        return { type: "response", status: 200, body: {} };
      }
      throw new Error(`不应发送 ${input.method} ${input.url}`);
    });

    const { clock } = renderApp(homeserver, "Waypoint Android", { viewportMode: () => "narrow" });
    await login(user);

    await user.click(await screen.findByRole("button", { name: /移动端与回源跳转/ }));
    expect(screen.getByRole("button", { name: "收藏 (1)" })).toBeInTheDocument();

    // 点击远端收藏条目 -> 从服务器 /messages 回源拉取并跳回高亮
    await user.click(screen.getByRole("button", { name: "收藏 (1)" }));
    const favDialog = await screen.findByRole("dialog", { name: "收藏（1）" });
    await user.click(within(favDialog).getByText("远端旧消息"));

    const timeline = screen.getByRole("log", { name: "对话时间线" });
    await waitFor(() => {
      const jumpedRow = timeline.querySelector('[data-event-id="$old-remote"]') as HTMLElement | null;
      expect(jumpedRow).not.toBeNull();
      expect(jumpedRow).toHaveAttribute("data-highlighted", "true");
    });

    // 移动端长按无说明文字的图片，打开底部 ActionSheet 发起收藏
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const imgBtn = screen.getByRole("button", { name: "查看图片 chart.png" });
      fireEvent.touchStart(imgBtn, { touches: [{ clientX: 24, clientY: 24 }] });
      await act(async () => {
        vi.advanceTimersByTime(550);
      });
    } finally {
      vi.useRealTimers();
    }
    const sheetMenu = await screen.findByRole("menu", { name: "消息操作" });
    expect(within(sheetMenu).queryByRole("menuitem", { name: "复制纯文本" })).not.toBeInTheDocument();
    await user.click(within(sheetMenu).getByRole("menuitem", { name: "收藏" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "收藏 (2)" })).toBeInTheDocument();
    });

    // 下一次前台 /sync 收到另一设备发来的撤回 ($old-remote) -> 消息和收藏数同步变为 1
    await advanceWhenTimerScheduled(clock, 5000);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "收藏 (1)" })).toBeInTheDocument();
      expect(within(timeline).queryByText("远端旧消息")).not.toBeInTheDocument();
    });

    // 删除 Topic -> 房间与收藏一并清理
    await user.click(screen.getByRole("button", { name: "话题操作" }));
    await user.click(await screen.findByRole("menuitem", { name: "删除" }));
    const delDialog = await screen.findByRole("alertdialog", { name: "确认删除 Topic" });
    await user.click(within(delDialog).getByRole("button", { name: "确认删除" }));

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /移动端与回源跳转/ })).not.toBeInTheDocument();
    });
    const snapshot = await loadV2Snapshot();
    expect(snapshot.rooms["!t1:example.com"]).toBeUndefined();
  });
});
