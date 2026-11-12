import type { TransportResult } from "../adapters/types";
import { localPlaceholderOf, type MatrixClient } from "./matrix-client";
import {
  disconnectedMessage,
  formatMatrixActionFailure,
  isRecord,
  transportFailureMessage,
} from "./matrix-errors";
import type { PendingRoomEvent, RawMatrixEvent, StoredRoomEvents } from "./session-store";

export type RegisteredAgent = {
  userId: string;
  handwrittenName?: string;
};

export type TopicSummary = {
  roomId: string;
  name: string;
  description?: string;
  agentUserId?: string;
  botDisplayName?: string;
  lastActivityTs?: number;
  pinned: boolean;
  unread: boolean;
  firstUnreadEventId?: string;
  readPositionUnknown: boolean;
  sendStatus?: "unconfirmed" | "failed";
};

export type CreateTopicResult =
  | { ok: true; roomId: string }
  | { ok: false; message: string };

export type PinTopicResult = { ok: true } | { ok: false; message: string };

export async function setTopicPinned(
  client: MatrixClient,
  roomId: string,
  pinned: boolean,
): Promise<PinTopicResult> {
  const action = pinned ? "置顶" : "取消置顶";
  if (!client.hasToken || !client.ownerId) {
    return { ok: false, message: disconnectedMessage(action) };
  }
  let result: TransportResult;
  try {
    result = pinned
      ? await client.putRoomTag(roomId, "im.waypoint.pinned", { order: 0 })
      : await client.deleteRoomTag(roomId, "im.waypoint.pinned");
  } catch {
    return {
      ok: false,
      message: formatMatrixActionFailure(action, { type: "failure", failure: { type: "network" } }),
    };
  }
  if (result.type === "response" && result.status >= 200 && result.status < 300) {
    await client.retainRoomTag(roomId, "im.waypoint.pinned", pinned ? { order: 0 } : undefined);
    return { ok: true };
  }
  return {
    ok: false,
    message: formatMatrixActionFailure(action, result, {
      serverErrorReason: "Homeserver 暂时不能完成请求",
      rejectedReason: "Homeserver 拒绝了请求",
    }),
  };
}

export type DeleteTopicResult =
  | { ok: true }
  | { ok: false; message: string };

export type UpdateTopicResult =
  | {
      ok: true;
      nameUpdated: boolean;
      descriptionUpdated: boolean;
    }
  | {
      ok: false;
      nameUpdated: boolean;
      descriptionUpdated: boolean;
      message: string;
    };

const directWriteQueues = new WeakMap<MatrixClient, Promise<void>>();

export function isFullUserId(user: string): boolean {
  if (!user.startsWith("@")) {
    return false;
  }
  const colon = user.indexOf(":");
  return (
    colon > 1 &&
    !user.slice(1, colon).includes("@") &&
    user.slice(colon + 1).trim() !== "" &&
    !/\s/.test(user)
  );
}

export function serverName(userId: string): string | undefined {
  const colon = userId.indexOf(":");
  if (colon < 0) {
    return undefined;
  }
  const server = userId.slice(colon + 1);
  return server ? server : undefined;
}

export function localpartOf(userId: string): string {
  const withoutAt = userId.startsWith("@") ? userId.slice(1) : userId;
  const colon = withoutAt.indexOf(":");
  return colon >= 0 ? withoutAt.slice(0, colon) : withoutAt;
}


export type ValidateAgentResult =
  | { ok: true; userId: string }
  | { ok: false; trimmed: string; message: string };

export function validateAgentUserId(
  raw: string,
  ownerUserId: string,
  existingAgents?: RegisteredAgent[],
): ValidateAgentResult {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: false, trimmed, message: "登记 Bot 失败，因为用户 ID 是空的。" };
  }
  if (!isFullUserId(trimmed)) {
    return {
      ok: false,
      trimmed,
      message: "登记 Bot 失败，因为只接受完整的 Matrix 用户 ID，不自动补 @ 或 server name。",
    };
  }
  const ownerServer = serverName(ownerUserId);
  if (!ownerServer || serverName(trimmed) !== ownerServer) {
    return {
      ok: false,
      trimmed,
      message: "登记 Bot 失败，因为 Bot 的 server name 必须与当前账号完全一致。",
    };
  }
  if (trimmed === ownerUserId) {
    return {
      ok: false,
      trimmed,
      message: "登记 Bot 失败，因为不能把自己登记成 Bot。",
    };
  }
  if (existingAgents?.some((agent) => agent.userId === trimmed)) {
    return {
      ok: false,
      trimmed,
      message: "登记 Bot 失败，因为这个 Bot 已经在名册里了。",
    };
  }
  return { ok: true, userId: trimmed };
}

function updateAgentsAccountData(
  existingContent: unknown,
  transform: (prevAgents: unknown[]) => unknown[],
): Record<string, unknown> {
  const base = isRecord(existingContent) ? { ...existingContent } : {};
  const prevAgents = Array.isArray(base.agents) ? base.agents : [];
  return {
    ...base,
    agents: transform(prevAgents),
  };
}

function makeAgentEntry(
  agentUserId: string,
  handwrittenName?: string,
  existing?: Record<string, unknown>,
): Record<string, unknown> {
  const trimmedName = handwrittenName?.trim();
  const entry: Record<string, unknown> = existing
    ? { ...existing }
    : { user_id: agentUserId };
  if (trimmedName) {
    entry.name = trimmedName;
  } else {
    delete entry.name;
  }
  return entry;
}

export function buildAddAgentContent(
  existingContent: unknown,
  agentUserId: string,
  handwrittenName?: string,
): Record<string, unknown> {
  return updateAgentsAccountData(existingContent, (prevAgents) => [
    ...prevAgents,
    makeAgentEntry(agentUserId, handwrittenName),
  ]);
}

export function buildRenameAgentContent(
  existingContent: unknown,
  agentUserId: string,
  handwrittenName?: string,
): Record<string, unknown> {
  return updateAgentsAccountData(existingContent, (prevAgents) => {
    let found = false;
    const nextAgents = prevAgents.map((item) => {
      if (!isRecord(item) || item.user_id !== agentUserId) {
        return item;
      }
      found = true;
      return makeAgentEntry(agentUserId, handwrittenName, item);
    });
    if (!found) {
      nextAgents.push(makeAgentEntry(agentUserId, handwrittenName));
    }
    return nextAgents;
  });
}

export function buildRemoveAgentContent(
  existingContent: unknown,
  agentUserId: string,
): Record<string, unknown> {
  return updateAgentsAccountData(existingContent, (prevAgents) =>
    prevAgents.filter((item) => !(isRecord(item) && item.user_id === agentUserId)),
  );
}

export type AgentsWriteResult = { ok: true } | { ok: false; message: string };

export async function saveRegisteredAgents(
  client: MatrixClient,
  action: string,
  nextContent: Record<string, unknown>,
): Promise<AgentsWriteResult> {
  if (!client.hasToken || !client.ownerId) {
    return { ok: false, message: disconnectedMessage(action) };
  }
  let result: TransportResult;
  try {
    result = await client.putAccountData("im.waypoint.agents", nextContent);
  } catch {
    return {
      ok: false,
      message: formatMatrixActionFailure(action, { type: "failure", failure: { type: "network" } }),
    };
  }
  if (result.type === "response" && result.status >= 200 && result.status < 300) {
    await client.retainAccountData("im.waypoint.agents", nextContent);
    return { ok: true };
  }
  return { ok: false, message: formatMatrixActionFailure(action, result) };
}

export function isValidAgentUserId(userId: string, ownerUserId: string): boolean {
  const ownerServer = serverName(ownerUserId);
  if (!ownerServer) {
    return false;
  }
  return isFullUserId(userId) && userId !== ownerUserId && serverName(userId) === ownerServer;
}

export function parseRegisteredAgents(content: unknown, ownerUserId: string): RegisteredAgent[] {
  if (!isRecord(content) || !Array.isArray(content.agents)) {
    return [];
  }
  const seen = new Set<string>();
  const registeredAgents: RegisteredAgent[] = [];
  for (const agent of content.agents) {
    if (!isRecord(agent)) {
      continue;
    }
    const userId = agent.user_id;
    if (typeof userId !== "string" || !isValidAgentUserId(userId, ownerUserId) || seen.has(userId)) {
      continue;
    }
    seen.add(userId);
    const handwrittenName =
      typeof agent.name === "string" && agent.name.trim() !== "" ? agent.name.trim() : undefined;
    registeredAgents.push({ userId, handwrittenName });
  }
  return registeredAgents;
}

export function resolveBotName(
  agentUserId: string,
  registeredAgents: RegisteredAgent[],
  roomScope?: StoredRoomEvents | StoredRoomEvents[],
): string {
  const registeredAgent = registeredAgents.find((entry) => entry.userId === agentUserId);
  if (registeredAgent?.handwrittenName) {
    return registeredAgent.handwrittenName;
  }
  const rooms = Array.isArray(roomScope) ? roomScope : roomScope ? [roomScope] : [];
  let best: { displayname: string; ts?: number } | undefined;
  for (const room of rooms) {
    const found = findMemberDisplayNameEvent(room.stateEvents, agentUserId);
    if (!found) {
      continue;
    }
    if (
      best === undefined ||
      (found.ts !== undefined && (best.ts === undefined || found.ts > best.ts))
    ) {
      best = found;
    }
  }
  if (best?.displayname) {
    return best.displayname;
  }
  return localpartOf(agentUserId);
}

function findMemberDisplayNameEvent(
  stateEvents: RawMatrixEvent[],
  userId: string,
): { displayname: string; ts?: number } | undefined {
  for (let i = stateEvents.length - 1; i >= 0; i -= 1) {
    const event = stateEvents[i];
    if (event.type === "m.room.member" && event.state_key === userId && isRecord(event.content)) {
      const rawDisplayName = event.content.displayname;
      if (typeof rawDisplayName === "string") {
        return {
          displayname: rawDisplayName.trim(),
          ts: validTimestamp(event.origin_server_ts),
        };
      }
      if ("displayname" in event.content || event.content.membership === "join") {
        return {
          displayname: "",
          ts: validTimestamp(event.origin_server_ts),
        };
      }
      return undefined;
    }
  }
  return undefined;
}

export function deriveTopics(
  rooms: Record<string, StoredRoomEvents>,
  registeredAgents: RegisteredAgent[],
  ownerUserId: string,
  pendingEvents: PendingRoomEvent[] = [],
): TopicSummary[] {
  const topics: TopicSummary[] = [];
  const allRooms = Object.values(rooms);

  for (const [roomId, room] of Object.entries(rooms)) {
    let hasTopicMarker = false;
    let topicMarkerContent: unknown;
    let markerTs: number | undefined;
    let createTs: number | undefined;
    let name: string | undefined;
    let description: string | undefined;

    for (const event of room.stateEvents) {
      if (typeof event.type !== "string" || typeof event.state_key !== "string") {
        continue;
      }
      const ts = validTimestamp(event.origin_server_ts);
      if (event.type === "im.waypoint.topic" && event.state_key === "") {
        hasTopicMarker = true;
        topicMarkerContent = event.content;
        if (markerTs === undefined && ts !== undefined) {
          markerTs = ts;
        }
      } else if (event.type === "m.room.create" && event.state_key === "") {
        if (ts !== undefined) {
          createTs = ts;
        }
      } else if (event.type === "m.room.name" && event.state_key === "") {
        name =
          isRecord(event.content) &&
          typeof event.content.name === "string" &&
          event.content.name.trim() !== ""
            ? event.content.name.trim()
            : undefined;
      } else if (event.type === "m.room.topic" && event.state_key === "") {
        description =
          isRecord(event.content) &&
          typeof event.content.topic === "string" &&
          event.content.topic.trim() !== ""
            ? event.content.topic.trim()
            : undefined;
      }
    }

    if (!hasTopicMarker) {
      continue;
    }

    const redactedIds = collectRedactedEventIds(room.timelineEvents);
    let lastMessageTs: number | undefined;
    let hasFailedMessage = false;
    let hasUnconfirmedMessage = false;
    for (const event of room.timelineEvents) {
      if (typeof event.state_key === "string") {
        continue;
      }
      if (isRedactedEvent(event, redactedIds)) {
        continue;
      }
      const local = localPlaceholderOf(event);
      if (local) {
        if (event.type === "m.room.message") {
          if (local.status === "failed") {
            hasFailedMessage = true;
          } else if (local.status === "unconfirmed") {
            hasUnconfirmedMessage = true;
          }
        }
        continue;
      }
      if (isActivityMessageEvent(event)) {
        const ts = validTimestamp(event.origin_server_ts);
        if (ts !== undefined) {
          lastMessageTs = lastMessageTs !== undefined ? Math.max(lastMessageTs, ts) : ts;
        }
      }
    }
    for (const pending of pendingEvents) {
      if (pending.roomId === roomId && pending.type === "m.room.message") {
        hasUnconfirmedMessage = true;
        break;
      }
    }
    const sendStatus: TopicSummary["sendStatus"] = hasFailedMessage
      ? "failed"
      : hasUnconfirmedMessage
        ? "unconfirmed"
        : undefined;

    const marker = parseTopicMarker(topicMarkerContent, ownerUserId);
    const agentUserId = marker.valid ? marker.agentUserId : undefined;
    const botDisplayName = agentUserId
      ? resolveBotName(agentUserId, registeredAgents, [
          room,
          ...allRooms.filter((candidate) => candidate !== room),
        ])
      : undefined;
    const lastActivityTs = lastMessageTs ?? createTs ?? markerTs;
    const pinned = isRecord(room.tags) && isRecord(room.tags["im.waypoint.pinned"]);
    const unreadState = deriveTopicUnreadState(room, agentUserId);

    topics.push({
      roomId,
      name: name ?? "未命名 Topic",
      description,
      agentUserId,
      botDisplayName,
      lastActivityTs,
      pinned,
      unread: unreadState.unread,
      firstUnreadEventId: unreadState.firstUnreadEventId,
      readPositionUnknown: unreadState.readPositionUnknown,
      ...(sendStatus ? { sendStatus } : {}),
    });
  }

  topics.sort((left, right) => {
    if (left.pinned !== right.pinned) {
      return left.pinned ? -1 : 1;
    }
    const leftTs = left.lastActivityTs ?? -1;
    const rightTs = right.lastActivityTs ?? -1;
    if (leftTs !== rightTs) {
      return rightTs - leftTs;
    }
    return left.roomId.localeCompare(right.roomId);
  });

  return topics;
}

export async function createTopicRoom(
  client: MatrixClient,
  input: {
    name: string;
    description?: string;
    agentUserId: string;
    now: number;
  },
): Promise<CreateTopicResult> {
  if (!client.hasToken) {
    return { ok: false, message: "新建 Topic 失败，因为尚未连接。" };
  }

  const body: Record<string, unknown> = {
    preset: "private_chat",
    is_direct: true,
    invite: [input.agentUserId],
    name: input.name,
    initial_state: [
      {
        type: "im.waypoint.topic",
        state_key: "",
        content: { v: 1, agent_user_id: input.agentUserId },
      },
      {
        type: "m.room.history_visibility",
        state_key: "",
        content: { history_visibility: "shared" },
      },
    ],
  };
  if (input.description) {
    body.topic = input.description;
  }

  let createResult: TransportResult;
  try {
    createResult = await client.createRoom(body);
  } catch {
    return { ok: false, message: "新建 Topic 失败，因为到达不了。" };
  }

  if (createResult.type !== "response" || createResult.status !== 200 || !isRecord(createResult.body)) {
    return { ok: false, message: createTopicFailureMessage(createResult) };
  }

  const rawRoomId = createResult.body.room_id;
  const roomId =
    typeof rawRoomId === "string" && rawRoomId.trim() !== "" ? rawRoomId.trim() : undefined;
  if (!roomId) {
    return { ok: false, message: "新建 Topic 失败，因为 Homeserver 没有返回房间 ID。" };
  }

  if (hasEncryptionInCreateResponse(createResult.body)) {
    await bestEffortLeaveAndForget(client, roomId);
    return {
      ok: false,
      message: "新建 Topic 失败，因为 Homeserver 强制开启了加密，Waypoint 不支持加密房间。",
    };
  }

  let encryptionResult: TransportResult;
  try {
    encryptionResult = await client.getRoomStateEvent(roomId, "m.room.encryption");
  } catch {
    await bestEffortLeaveAndForget(client, roomId);
    return { ok: false, message: "新建 Topic 失败，因为无法确认房间是否未加密。" };
  }

  if (encryptionResult.type === "response" && encryptionResult.status === 200) {
    await bestEffortLeaveAndForget(client, roomId);
    return {
      ok: false,
      message: "新建 Topic 失败，因为 Homeserver 强制开启了加密，Waypoint 不支持加密房间。",
    };
  }

  if (!(encryptionResult.type === "response" && encryptionResult.status === 404)) {
    await bestEffortLeaveAndForget(client, roomId);
    return { ok: false, message: createTopicFailureMessage(encryptionResult) };
  }

  const initialStateEvents: RawMatrixEvent[] = [
    {
      type: "m.room.create",
      state_key: "",
      origin_server_ts: input.now,
      content: { creator: client.ownerId },
    },
    {
      type: "im.waypoint.topic",
      state_key: "",
      origin_server_ts: input.now,
      content: { v: 1, agent_user_id: input.agentUserId },
    },
    {
      type: "m.room.name",
      state_key: "",
      origin_server_ts: input.now,
      content: { name: input.name },
    },
    ...(input.description
      ? [
          {
            type: "m.room.topic",
            state_key: "",
            origin_server_ts: input.now,
            content: { topic: input.description },
          },
        ]
      : []),
    {
      type: "m.room.history_visibility",
      state_key: "",
      origin_server_ts: input.now,
      content: { history_visibility: "shared" },
    },
    {
      type: "m.room.member",
      state_key: client.ownerId,
      origin_server_ts: input.now,
      content: { membership: "join" },
    },
    {
      type: "m.room.member",
      state_key: input.agentUserId,
      origin_server_ts: input.now,
      content: { membership: "invite" },
    },
  ];

  await client.rememberRoomStateEvents(roomId, initialStateEvents);
  return { ok: true, roomId };
}

function enqueueDirectAccountDataWrite(
  client: MatrixClient,
  computeNext: (current: unknown) => Record<string, string[]> | undefined,
): Promise<void> {
  const prev = directWriteQueues.get(client) ?? Promise.resolve();
  const next = prev
    .catch(() => undefined)
    .then(async () => {
      if (!client.hasToken || !client.ownerId) {
        return;
      }
      const nextDirect = computeNext(client.accountData("m.direct"));
      if (!nextDirect) {
        return;
      }
      try {
        const result = await client.putAccountData("m.direct", nextDirect);
        if (result.type === "response" && result.status >= 200 && result.status < 300) {
          await client.retainAccountData("m.direct", nextDirect);
        }
      } catch {
        // Best-effort per ADR-0023: never fail or roll back Topic lifecycle
      }
    });
  directWriteQueues.set(client, next);
  return next;
}

export function appendDirectRoom(
  client: MatrixClient,
  agentUserId: string,
  roomId: string,
): Promise<void> {
  return enqueueDirectAccountDataWrite(client, (current) =>
    appendDirectRoomMapping(current, agentUserId, roomId),
  );
}

export function removeDirectRoom(client: MatrixClient, roomId: string): Promise<void> {
  return enqueueDirectAccountDataWrite(client, (current) => {
    const { changed, next } = removeDirectRoomMapping(current, roomId);
    return changed ? next : undefined;
  });
}

export async function deleteTopicRoom(
  client: MatrixClient,
  roomId: string,
): Promise<DeleteTopicResult> {
  if (!client.hasToken) {
    return { ok: false, message: disconnectedMessage("删除 Topic") };
  }
  let leaveResult: TransportResult;
  try {
    leaveResult = await client.leaveRoom(roomId);
  } catch {
    return {
      ok: false,
      message: formatMatrixActionFailure("删除 Topic", {
        type: "failure",
        failure: { type: "network" },
      }),
    };
  }
  if (leaveResult.type !== "response" || leaveResult.status < 200 || leaveResult.status >= 300) {
    return {
      ok: false,
      message: formatMatrixActionFailure("删除 Topic", leaveResult, {
        serverErrorReason: "Homeserver 暂时不能完成请求",
        rejectedReason: "Homeserver 拒绝了请求",
      }),
    };
  }
  await client.removeLeftRoom(roomId);
  if (client.hasToken) {
    try {
      void client.forgetRoom(roomId).then(
        () => undefined,
        () => undefined,
      );
    } catch {
      // Best-effort forget
    }
    void removeDirectRoom(client, roomId);
  }
  return { ok: true };
}

async function bestEffortLeaveAndForget(client: MatrixClient, roomId: string): Promise<void> {
  try {
    await client.leaveRoom(roomId);
  } catch {
    // Best-effort cleanup
  }
  try {
    await client.forgetRoom(roomId);
  } catch {
    // Best-effort cleanup
  }
}

function hasEncryptionInCreateResponse(body: Record<string, unknown>): boolean {
  if (body.encrypted === true || "m.room.encryption" in body) {
    return true;
  }
  for (const key of ["state", "initial_state"]) {
    const value = body[key];
    if (Array.isArray(value)) {
      if (value.some((ev) => isRecord(ev) && ev.type === "m.room.encryption")) {
        return true;
      }
    }
  }
  return false;
}

function createTopicFailureMessage(result: TransportResult): string {
  return formatMatrixActionFailure("新建 Topic", result, {
    serverErrorReason: "Homeserver 暂时不能创建房间",
    rejectedReason: "Homeserver 拒绝了建房请求",
  });
}

function isActivityMessageEvent(event: RawMatrixEvent): boolean {
  if (event.type !== "m.room.message") {
    return false;
  }
  if (!isRecord(event.content)) {
    return true;
  }
  const relatesTo = event.content["m.relates_to"];
  if (isRecord(relatesTo) && relatesTo.rel_type === "m.replace") {
    return false;
  }
  return true;
}

function validTimestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseTopicMarker(
  content: unknown,
  ownerUserId: string,
): { valid: true; agentUserId: string } | { valid: false } {
  if (!isRecord(content)) {
    return { valid: false };
  }
  if (content.v !== 1) {
    return { valid: false };
  }
  const agentUserId = content.agent_user_id;
  if (typeof agentUserId !== "string" || !isValidAgentUserId(agentUserId, ownerUserId)) {
    return { valid: false };
  }
  return { valid: true, agentUserId };
}

export function resolvePreselectedBotId(
  topics: TopicSummary[],
  registeredAgents: RegisteredAgent[],
): string {
  if (registeredAgents.length <= 1 || topics.length === 0) {
    return "";
  }
  let latest = topics[0];
  for (const topic of topics) {
    const latestTs = latest.lastActivityTs ?? -1;
    const candidateTs = topic.lastActivityTs ?? -1;
    if (candidateTs > latestTs || (candidateTs === latestTs && topic.roomId.localeCompare(latest.roomId) < 0)) {
      latest = topic;
    }
  }
  if (latest.lastActivityTs === undefined || !latest.agentUserId) {
    return "";
  }
  return registeredAgents.some((bot) => bot.userId === latest.agentUserId)
    ? latest.agentUserId
    : "";
}

export function appendDirectRoomMapping(
  current: unknown,
  agentUserId: string,
  roomId: string,
): Record<string, string[]> {
  const next: Record<string, string[]> = {};
  if (isRecord(current)) {
    for (const [key, value] of Object.entries(current)) {
      if (Array.isArray(value)) {
        next[key] = value.filter((item): item is string => typeof item === "string");
      }
    }
  }
  const existingForAgent = next[agentUserId] ?? [];
  next[agentUserId] = existingForAgent.includes(roomId)
    ? existingForAgent
    : [...existingForAgent, roomId];
  return next;
}

export function removeDirectRoomMapping(
  current: unknown,
  roomId: string,
): { changed: boolean; next: Record<string, string[]> } {
  if (!isRecord(current)) {
    return { changed: false, next: {} };
  }
  let changed = false;
  const next: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(current)) {
    if (!Array.isArray(value)) {
      continue;
    }
    const rooms = value.filter((item): item is string => typeof item === "string");
    const filtered = rooms.filter((item) => item !== roomId);
    if (filtered.length !== rooms.length) {
      changed = true;
    }
    if (filtered.length > 0) {
      next[key] = filtered;
    }
  }
  return { changed, next };
}

export async function updateTopicDetails(
  client: MatrixClient,
  input: {
    roomId: string;
    currentName: string;
    currentDescription: string;
    nextName: string;
    nextDescription: string;
    now: number;
  },
): Promise<UpdateTopicResult> {
  const nameChanged = input.nextName !== input.currentName;
  const descriptionChanged = input.nextDescription !== input.currentDescription;
  if (!nameChanged && !descriptionChanged) {
    return { ok: true, nameUpdated: false, descriptionUpdated: false };
  }
  if (!client.hasToken) {
    return {
      ok: false,
      nameUpdated: false,
      descriptionUpdated: false,
      message: "更新 Topic 失败，因为尚未连接。",
    };
  }

  async function sendStateField(
    eventType: "m.room.name" | "m.room.topic",
    content: Record<string, unknown>,
    actionLabel: string,
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    let result: TransportResult;
    try {
      result = await client.putRoomStateEvent(input.roomId, eventType, content);
    } catch {
      return {
        ok: false,
        message: transportFailureMessage(actionLabel, { type: "network" }),
      };
    }
    if (result.type === "response" && result.status >= 200 && result.status < 300) {
      const eventId =
        isRecord(result.body) && typeof result.body.event_id === "string" && result.body.event_id
          ? result.body.event_id
          : undefined;
      await client.rememberRoomStateEvents(input.roomId, [
        {
          type: eventType,
          state_key: "",
          origin_server_ts: input.now,
          ...(eventId ? { event_id: eventId } : {}),
          content,
        },
      ]);
      return { ok: true };
    }
    return {
      ok: false,
      message: formatMatrixActionFailure(actionLabel, result, {
        serverErrorReason: "Homeserver 暂时不能完成请求",
        rejectedReason: "Homeserver 拒绝了请求",
      }),
    };
  }

  const [nameOutcome, descriptionOutcome] = await Promise.all([
    nameChanged
      ? sendStateField("m.room.name", { name: input.nextName }, "更新 Topic 名字")
      : Promise.resolve(undefined),
    descriptionChanged
      ? sendStateField("m.room.topic", { topic: input.nextDescription }, "更新 Description")
      : Promise.resolve(undefined),
  ]);

  const nameUpdated = nameOutcome?.ok === true;
  const descriptionUpdated = descriptionOutcome?.ok === true;
  const errors: string[] = [];
  if (nameOutcome && !nameOutcome.ok) {
    errors.push(nameOutcome.message);
  }
  if (descriptionOutcome && !descriptionOutcome.ok) {
    errors.push(descriptionOutcome.message);
  }

  if (errors.length === 0) {
    return { ok: true, nameUpdated, descriptionUpdated };
  }
  return {
    ok: false,
    nameUpdated,
    descriptionUpdated,
    message: errors.join(" "),
  };
}

export type TimelineItem =
  | {
      kind: "day-separator";
      key: string;
      label: string;
    }
  | {
      kind: "message";
      key: string;
      eventId?: string;
      side: "left" | "right";
      body: string;
      status: "confirmed" | "unconfirmed" | "failed";
      localId?: string;
    };

function stripStreamingCursor(body: string): string {
  return body.replace(/ ?▉$/, "");
}

function collectLatestEdits(
  events: RawMatrixEvent[],
  redactedIds: Set<string>,
): Map<string, { body: string; ts: number | undefined }> {
  const targets = new Map<string, { sender: string; msgtype: unknown }>();
  for (const event of events) {
    if (
      typeof event.state_key === "string" ||
      localPlaceholderOf(event) ||
      isRedactedEvent(event, redactedIds) ||
      !isActivityMessageEvent(event) ||
      typeof event.event_id !== "string" ||
      event.event_id === "" ||
      typeof event.sender !== "string" ||
      !isRecord(event.content)
    ) {
      continue;
    }
    targets.set(event.event_id, {
      sender: event.sender,
      msgtype: event.content.msgtype,
    });
  }

  const latestEdits = new Map<string, { body: string; ts: number | undefined }>();
  for (const event of events) {
    if (
      typeof event.state_key === "string" ||
      localPlaceholderOf(event) ||
      isRedactedEvent(event, redactedIds) ||
      event.type !== "m.room.message" ||
      typeof event.sender !== "string" ||
      !isRecord(event.content)
    ) {
      continue;
    }
    const relatesTo = event.content["m.relates_to"];
    if (
      !isRecord(relatesTo) ||
      relatesTo.rel_type !== "m.replace" ||
      typeof relatesTo.event_id !== "string" ||
      relatesTo.event_id === ""
    ) {
      continue;
    }
    const target = targets.get(relatesTo.event_id);
    if (!target || target.sender !== event.sender) {
      continue;
    }
    const newContent = event.content["m.new_content"];
    if (!isRecord(newContent) || typeof newContent.body !== "string") {
      continue;
    }
    const effectiveMsgtype =
      newContent.msgtype !== undefined ? newContent.msgtype : target.msgtype;
    if (effectiveMsgtype !== "m.text") {
      continue;
    }
    const editTs = validTimestamp(event.origin_server_ts);
    const prev = latestEdits.get(relatesTo.event_id);
    if (
      prev !== undefined &&
      prev.ts !== undefined &&
      editTs !== undefined &&
      editTs < prev.ts
    ) {
      continue;
    }
    latestEdits.set(relatesTo.event_id, {
      body: newContent.body,
      ts: editTs,
    });
  }
  return latestEdits;
}

export function deriveRoomTimelineItems(
  room: StoredRoomEvents | undefined,
  pendingEvents: PendingRoomEvent[],
  ownerUserId: string,
  agentUserId: string | undefined,
  nowMs: number,
): TimelineItem[] {
  const items: TimelineItem[] = [];
  let lastDayKey: string | undefined;

  const seenLocalTxnIds = new Set<string>();

  if (room) {
    const redactedIds = collectRedactedEventIds(room.timelineEvents);
    const latestEdits = collectLatestEdits(room.timelineEvents, redactedIds);
    room.timelineEvents.forEach((event, index) => {
      if (
        typeof event.state_key === "string" ||
        isRedactedEvent(event, redactedIds) ||
        !isActivityMessageEvent(event)
      ) {
        return;
      }
      const local = localPlaceholderOf(event);
      if (local) {
        seenLocalTxnIds.add(local.txnId);
        if (
          !isRecord(event.content) ||
          event.content.msgtype !== "m.text" ||
          typeof event.content.body !== "string" ||
          event.content.body.trim() === ""
        ) {
          return;
        }
        items.push({
          kind: "message",
          key: `local-${local.id}`,
          side: "right",
          body: event.content.body,
          status: local.status,
          localId: local.id,
        });
        return;
      }
      const sender = typeof event.sender === "string" ? event.sender : undefined;
      let side: "left" | "right" | undefined;
      if (sender === ownerUserId) {
        side = "right";
      } else if (agentUserId && sender === agentUserId) {
        side = "left";
      }
      if (!side) {
        return;
      }
      if (
        !isRecord(event.content) ||
        event.content.msgtype !== "m.text" ||
        typeof event.content.body !== "string"
      ) {
        return;
      }
      const rawEventId =
        typeof event.event_id === "string" && event.event_id !== ""
          ? event.event_id
          : undefined;
      const edit = rawEventId ? latestEdits.get(rawEventId) : undefined;
      const rawBody = edit ? edit.body : event.content.body;
      const body = edit || side === "left" ? stripStreamingCursor(rawBody) : rawBody;
      if (body.trim() === "") {
        return;
      }
      const eventId = rawEventId ?? `confirmed-${index}`;
      const ts = validTimestamp(event.origin_server_ts);
      if (ts !== undefined) {
        const currentDay = localDayKey(ts);
        if (lastDayKey !== undefined && currentDay !== lastDayKey) {
          items.push({
            kind: "day-separator",
            key: `day-${currentDay}-${eventId}`,
            label: formatDaySeparator(ts, nowMs),
          });
        }
        lastDayKey = currentDay;
      }
      items.push({
        kind: "message",
        key: eventId,
        eventId: typeof event.event_id === "string" && event.event_id !== "" ? event.event_id : undefined,
        side,
        body,
        status: "confirmed",
      });
    });
  }

  for (const pending of pendingEvents) {
    if (seenLocalTxnIds.has(pending.txnId)) {
      continue;
    }
    if (
      pending.type !== "m.room.message" ||
      pending.content.msgtype !== "m.text" ||
      typeof pending.content.body !== "string" ||
      pending.content.body.trim() === ""
    ) {
      continue;
    }
    items.push({
      kind: "message",
      key: `pending-${pending.txnId}`,
      side: "right",
      body: pending.content.body,
      status: "unconfirmed",
      localId: pending.txnId,
    });
  }

  return items;
}

function localDayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

export function formatTopicListTime(ts: number, nowMs: number): string {
  const targetKey = localDayKey(ts);
  if (targetKey === localDayKey(nowMs)) {
    return new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(ts));
  }
  const yesterday = new Date(nowMs);
  yesterday.setDate(yesterday.getDate() - 1);
  if (targetKey === localDayKey(yesterday.getTime())) {
    return "昨天";
  }
  const targetDate = new Date(ts);
  const nowDate = new Date(nowMs);
  if (targetDate.getFullYear() === nowDate.getFullYear()) {
    return new Intl.DateTimeFormat(undefined, {
      month: "numeric",
      day: "numeric",
    }).format(targetDate);
  }
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).format(targetDate);
}

function formatDaySeparator(ts: number, nowMs: number): string {
  const targetKey = localDayKey(ts);
  if (targetKey === localDayKey(nowMs)) {
    return "今天";
  }
  const yesterday = new Date(nowMs);
  yesterday.setDate(yesterday.getDate() - 1);
  if (targetKey === localDayKey(yesterday.getTime())) {
    return "昨天";
  }
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).format(new Date(ts));
}

export function collectRedactedEventIds(events: RawMatrixEvent[]): Set<string> {
  const redactedIds = new Set<string>();
  for (const event of events) {
    if (event.type !== "m.room.redaction") {
      continue;
    }
    const target =
      typeof event.redacts === "string" && event.redacts !== ""
        ? event.redacts
        : isRecord(event.content) &&
            typeof event.content.redacts === "string" &&
            event.content.redacts !== ""
          ? event.content.redacts
          : undefined;
    if (target) {
      redactedIds.add(target);
    }
  }
  return redactedIds;
}

export function isRedactedEvent(event: RawMatrixEvent, redactedIds: Set<string>): boolean {
  if (typeof event.event_id === "string" && redactedIds.has(event.event_id)) {
    return true;
  }
  if (isRecord(event.unsigned) && isRecord(event.unsigned.redacted_because)) {
    return true;
  }
  return false;
}

function isRenderableTextBubbleEvent(
  event: RawMatrixEvent,
  redactedIds: Set<string>,
  latestEdits: Map<string, { body: string; ts: number | undefined }>,
  agentUserId: string | undefined,
): boolean {
  if (
    typeof event.state_key === "string" ||
    localPlaceholderOf(event) ||
    isRedactedEvent(event, redactedIds) ||
    !isActivityMessageEvent(event)
  ) {
    return false;
  }
  if (
    !isRecord(event.content) ||
    event.content.msgtype !== "m.text" ||
    typeof event.content.body !== "string"
  ) {
    return false;
  }
  const rawEventId =
    typeof event.event_id === "string" && event.event_id !== "" ? event.event_id : undefined;
  const edit = rawEventId ? latestEdits.get(rawEventId) : undefined;
  const rawBody = edit ? edit.body : event.content.body;
  const isAgentSide = Boolean(agentUserId) && event.sender === agentUserId;
  const body = edit || isAgentSide ? stripStreamingCursor(rawBody) : rawBody;
  return body.trim() !== "";
}

function deriveTopicUnreadState(
  room: StoredRoomEvents,
  agentUserId: string | undefined,
): { unread: boolean; firstUnreadEventId?: string; readPositionUnknown: boolean } {
  const readPos = room.readPositionEventId;
  let startIndex = -1;
  if (readPos !== undefined) {
    startIndex = room.timelineEvents.findIndex(
      (event) => !localPlaceholderOf(event) && event.event_id === readPos,
    );
    if (startIndex === -1) {
      return { unread: false, readPositionUnknown: true };
    }
  }
  if (!agentUserId) {
    return { unread: false, readPositionUnknown: false };
  }
  const redactedIds = collectRedactedEventIds(room.timelineEvents);
  const latestEdits = collectLatestEdits(room.timelineEvents, redactedIds);
  for (let i = startIndex + 1; i < room.timelineEvents.length; i += 1) {
    const event = room.timelineEvents[i];
    if (event.sender !== agentUserId) {
      continue;
    }
    if (!isRenderableTextBubbleEvent(event, redactedIds, latestEdits, agentUserId)) {
      continue;
    }
    const eventId =
      typeof event.event_id === "string" && event.event_id !== "" ? event.event_id : undefined;
    return {
      unread: true,
      firstUnreadEventId: eventId,
      readPositionUnknown: false,
    };
  }
  return { unread: false, readPositionUnknown: false };
}

export type BubbleVisibility = "above" | "visible" | "below";

export function computeTargetReadPosition(
  room: StoredRoomEvents | undefined,
  ownerUserId: string,
  agentUserId: string | undefined,
  visibilityByEventId: Map<string, BubbleVisibility>,
): string | undefined {
  if (!room || room.timelineEvents.length === 0) {
    return undefined;
  }
  const events = room.timelineEvents;
  let startIndex = -1;
  if (room.readPositionEventId !== undefined) {
    startIndex = events.findIndex(
      (event) => !localPlaceholderOf(event) && event.event_id === room.readPositionEventId,
    );
    if (startIndex === -1) {
      return undefined;
    }
  }

  const redactedIds = collectRedactedEventIds(events);
  const latestEdits = collectLatestEdits(events, redactedIds);
  let limitIndex = events.length - 1;

  if (room.timelineGap?.limited) {
    if (room.timelineGap.gapBeforeEventId) {
      const gapIdx = events.findIndex(
        (event) => !localPlaceholderOf(event) && event.event_id === room.timelineGap?.gapBeforeEventId,
      );
      if (gapIdx > startIndex && !(startIndex === -1 && gapIdx === 0)) {
        limitIndex = Math.min(limitIndex, gapIdx - 1);
      }
    }
  }

  for (let i = startIndex + 1; i <= limitIndex; i += 1) {
    const event = events[i];
    if (!isRenderableParticipantBubble(event, ownerUserId, agentUserId, redactedIds, latestEdits)) {
      continue;
    }
    const eventId =
      typeof event.event_id === "string" && event.event_id !== "" ? event.event_id : undefined;
    if (!eventId) {
      continue;
    }
    const visibility = visibilityByEventId.get(eventId);
    if (visibility === "below" || visibility === undefined) {
      limitIndex = Math.min(limitIndex, i - 1);
      break;
    }
  }

  for (let i = limitIndex; i > startIndex; i -= 1) {
    const event = events[i];
    const eventId =
      typeof event.event_id === "string" && event.event_id !== "" ? event.event_id : undefined;
    if (!eventId || localPlaceholderOf(event) || isRedactedEvent(event, redactedIds)) {
      continue;
    }
    if (isRenderableParticipantBubble(event, ownerUserId, agentUserId, redactedIds, latestEdits)) {
      const visibility = visibilityByEventId.get(eventId);
      if (visibility === "visible" || visibility === "above") {
        return eventId;
      }
    }
    const replaceTargetId = replaceTargetEventId(event, ownerUserId, agentUserId);
    if (replaceTargetId) {
      const targetVisibility = visibilityByEventId.get(replaceTargetId);
      if (targetVisibility === "visible") {
        return eventId;
      }
    }
  }

  return undefined;
}

function isRenderableParticipantBubble(
  event: RawMatrixEvent,
  ownerUserId: string,
  agentUserId: string | undefined,
  redactedIds: Set<string>,
  latestEdits: Map<string, { body: string; ts: number | undefined }>,
): boolean {
  if (!isRenderableTextBubbleEvent(event, redactedIds, latestEdits, agentUserId)) {
    return false;
  }
  const sender = typeof event.sender === "string" ? event.sender : undefined;
  return sender === ownerUserId || (Boolean(agentUserId) && sender === agentUserId);
}

function replaceTargetEventId(
  event: RawMatrixEvent,
  ownerUserId: string,
  agentUserId: string | undefined,
): string | undefined {
  if (typeof event.state_key === "string" || localPlaceholderOf(event) || event.type !== "m.room.message") {
    return undefined;
  }
  const sender = typeof event.sender === "string" ? event.sender : undefined;
  if (sender !== ownerUserId && !(agentUserId && sender === agentUserId)) {
    return undefined;
  }
  if (!isRecord(event.content)) {
    return undefined;
  }
  const relatesTo = event.content["m.relates_to"];
  if (!isRecord(relatesTo) || relatesTo.rel_type !== "m.replace") {
    return undefined;
  }
  return typeof relatesTo.event_id === "string" && relatesTo.event_id !== ""
    ? relatesTo.event_id
    : undefined;
}
