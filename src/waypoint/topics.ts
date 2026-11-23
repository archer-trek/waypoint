import type { TransportResult } from "../adapters/types";
import { localPlaceholderOf, parseMxcUri, roomTimelineGaps, type MatrixClient } from "./matrix-client";
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
  lastMessagePreview?: string;
  pinned: boolean;
  unread: boolean;
  firstUnreadEventId?: string;
  readPositionUnknown: boolean;
  needsReadGapBackfill?: boolean;
  responding: boolean;
  sendStatus?: "unconfirmed" | "failed";
  unavailable: boolean;
  unavailableReason?: string;
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
      message: `${action}失败：${formatMatrixActionFailure(action, { type: "failure", failure: { type: "network" } })}`,
    };
  }
  if (result.type === "response" && result.status >= 200 && result.status < 300) {
    try {
      await client.retainRoomTag(roomId, "im.waypoint.pinned", pinned ? { order: 0 } : undefined);
    } catch {
      return {
        ok: false,
        message: "本地存储空间不足，未能保存置顶状态，请清理空间后重试。",
      };
    }
    return { ok: true };
  }
  return {
    ok: false,
    message: `${action}失败：${formatMatrixActionFailure(action, result, {
      serverErrorReason: "服务器暂时无法响应，请稍后重试。",
      rejectedReason: "服务器拒绝了该请求。",
    })}`,
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

export function isLocalpart(user: string): boolean {
  if (user.includes("@") || user.includes(":") || /\s/.test(user)) {
    return false;
  }
  if (user.startsWith("+")) {
    return false;
  }
  const digits = user.replace(/\D/g, "");
  if (/^[\d\s().-]+$/.test(user) && digits.length >= 7) {
    return false;
  }
  return user.length > 0;
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
    return { ok: false, trimmed, message: "请输入 Bot 用户名。" };
  }
  const ownerServer = serverName(ownerUserId);
  let resolvedUserId: string;
  if (isLocalpart(trimmed)) {
    if (!ownerServer) {
      return {
        ok: false,
        trimmed,
        message: "Bot 必须与当前账号位于同一台 Homeserver。",
      };
    }
    resolvedUserId = `@${trimmed}:${ownerServer}`;
  } else if (isFullUserId(trimmed)) {
    if (!ownerServer || serverName(trimmed) !== ownerServer) {
      return {
        ok: false,
        trimmed,
        message: "Bot 必须与当前账号位于同一台 Homeserver。",
      };
    }
    resolvedUserId = trimmed;
  } else {
    return {
      ok: false,
      trimmed,
      message: "请输入有效的 Bot 用户名或完整 Matrix 用户 ID。",
    };
  }
  if (resolvedUserId === ownerUserId) {
    return {
      ok: false,
      trimmed,
      message: "不能将自己登记为 Bot。",
    };
  }
  if (existingAgents?.some((agent) => agent.userId === resolvedUserId)) {
    return {
      ok: false,
      trimmed,
      message: "该 Bot 已在名册中。",
    };
  }
  return { ok: true, userId: resolvedUserId };
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
    try {
      await client.retainAccountData("im.waypoint.agents", nextContent);
    } catch {
      return {
        ok: false,
        message: "本地存储空间不足，未能保存 Bot 名册，请清理空间后重试。",
      };
    }
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
  const pendingByRoom = new Map<string, PendingRoomEvent[]>();
  for (const pending of pendingEvents) {
    const list = pendingByRoom.get(pending.roomId);
    if (list) {
      list.push(pending);
    } else {
      pendingByRoom.set(pending.roomId, [pending]);
    }
  }

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
    const roomPending = pendingByRoom.get(roomId) ?? [];
    for (const pending of roomPending) {
      if (pending.type === "m.room.message") {
        hasUnconfirmedMessage = true;
        break;
      }
    }
    const sendStatus: TopicSummary["sendStatus"] = hasFailedMessage
      ? "failed"
      : hasUnconfirmedMessage
        ? "unconfirmed"
        : undefined;

    const availability = deriveTopicAvailability(topicMarkerContent, room, ownerUserId);
    const agentUserId = availability.agentUserId;
    const botDisplayName = agentUserId
      ? resolveBotName(agentUserId, registeredAgents, [
          room,
          ...allRooms.filter((candidate) => candidate !== room),
        ])
      : undefined;
    const lastActivityTs =
      (lastMessageTs !== undefined && room.lastActivityTs !== undefined
        ? Math.max(lastMessageTs, room.lastActivityTs)
        : (room.lastActivityTs ?? lastMessageTs)) ??
      createTs ??
      markerTs;
    const pinned = isRecord(room.tags) && isRecord(room.tags["im.waypoint.pinned"]);
    const unreadState = deriveTopicUnreadState(room, agentUserId);
    const responding = collectActiveEyesTargetIds(room.timelineEvents, redactedIds, agentUserId).size > 0;
    const lastMessagePreview =
      deriveLatestMessagePreview(room, roomPending, ownerUserId, agentUserId, redactedIds) ??
      room.coldLatestPreview;

    topics.push({
      roomId,
      name: name ?? "未命名 Topic",
      description,
      agentUserId,
      botDisplayName,
      lastActivityTs,
      ...(lastMessagePreview !== undefined ? { lastMessagePreview } : {}),
      pinned,
      unread: unreadState.unread,
      firstUnreadEventId: unreadState.firstUnreadEventId,
      readPositionUnknown: unreadState.readPositionUnknown,
      needsReadGapBackfill:
        unreadState.readPositionUnknown ||
        hasLimitedGapAfterReadPosition(room) ||
        (room.readPositionEventId === undefined && Boolean(room.hasOlderLocalChunks)),
      responding,
      ...(sendStatus ? { sendStatus } : {}),
      unavailable: availability.unavailable,
      ...(availability.reason ? { unavailableReason: availability.reason } : {}),
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
    return { ok: false, message: "尚未连接到服务器，请先登录。" };
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
    return { ok: false, message: "无法连接到服务器，请检查网络后重试。" };
  }

  if (createResult.type !== "response" || createResult.status !== 200 || !isRecord(createResult.body)) {
    return { ok: false, message: createTopicFailureMessage(createResult) };
  }

  const rawRoomId = createResult.body.room_id;
  const roomId =
    typeof rawRoomId === "string" && rawRoomId.trim() !== "" ? rawRoomId.trim() : undefined;
  if (!roomId) {
    return { ok: false, message: "服务器未返回房间信息，创建 Topic 失败。" };
  }

  if (hasEncryptionInCreateResponse(createResult.body)) {
    await bestEffortLeaveAndForget(client, roomId);
    return {
      ok: false,
      message: "Homeserver 强制开启了加密，Waypoint 暂不支持加密房间。",
    };
  }

  let encryptionResult: TransportResult;
  try {
    encryptionResult = await client.getRoomStateEvent(roomId, "m.room.encryption");
  } catch {
    await bestEffortLeaveAndForget(client, roomId);
    return { ok: false, message: "无法确认房间加密状态，请稍后重试。" };
  }

  if (encryptionResult.type === "response" && encryptionResult.status === 200) {
    await bestEffortLeaveAndForget(client, roomId);
    return {
      ok: false,
      message: "Homeserver 强制开启了加密，Waypoint 暂不支持加密房间。",
    };
  }

  if (!(encryptionResult.type === "response" && encryptionResult.status === 404)) {
    await bestEffortLeaveAndForget(client, roomId);
    return { ok: false, message: createTopicFailureMessage(encryptionResult) };
  }

  const createAgentMember = extractAgentMemberFromCreateResponse(
    createResult.body,
    input.agentUserId,
  );
  const inviteFailed = hasExplicitInviteFailureInCreateResponse(
    createResult.body,
    input.agentUserId,
  );
  const agentMemberEvent: RawMatrixEvent = createAgentMember
    ? {
        ...createAgentMember,
        type: "m.room.member",
        state_key: input.agentUserId,
        origin_server_ts:
          typeof createAgentMember.origin_server_ts === "number"
            ? createAgentMember.origin_server_ts
            : input.now,
      }
    : {
        type: "m.room.member",
        state_key: input.agentUserId,
        origin_server_ts: input.now,
        content: { membership: inviteFailed ? "leave" : "invite" },
      };

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
    agentMemberEvent,
  ];

  try {
    await client.rememberRoomStateEvents(
      roomId,
      initialStateEvents,
      inviteFailed ? { inviteFailed: true } : undefined,
    );
  } catch {
    return { ok: false, message: "本地存储空间不足，未能保存 Topic 状态，请清理空间后重试。" };
  }
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
        serverErrorReason: "服务器暂时无法响应，请稍后重试。",
        rejectedReason: "服务器拒绝了该请求。",
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

function extractAgentMemberFromCreateResponse(
  body: Record<string, unknown>,
  agentUserId: string,
): RawMatrixEvent | undefined {
  for (const key of ["state", "initial_state"]) {
    const value = body[key];
    if (Array.isArray(value)) {
      const found = value.find(
        (ev) => isRecord(ev) && ev.type === "m.room.member" && ev.state_key === agentUserId,
      );
      if (isRecord(found)) {
        return found;
      }
    }
  }
  return undefined;
}

function hasExplicitInviteFailureInCreateResponse(
  body: Record<string, unknown>,
  agentUserId: string,
): boolean {
  if (body.invite_failed === true) {
    return true;
  }
  if (typeof body.invite_error === "string" && body.invite_error.trim() !== "") {
    return true;
  }
  if (Array.isArray(body.failed_invites) && body.failed_invites.includes(agentUserId)) {
    return true;
  }
  if (isRecord(body.invite_failures) && agentUserId in body.invite_failures) {
    return true;
  }
  const member = extractAgentMemberFromCreateResponse(body, agentUserId);
  if (member && isRecord(member.content)) {
    const membership = member.content.membership;
    if (membership === "leave" || membership === "ban") {
      return true;
    }
  }
  return false;
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
    serverErrorReason: "服务器暂时无法创建 Topic，请稍后重试。",
    rejectedReason: "服务器拒绝创建 Topic。",
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

export function parseTopicMarker(
  content: unknown,
  ownerUserId: string,
):
  | { valid: true; agentUserId: string }
  | { valid: false; reason: "unsupported-version" | "invalid-agent-id" } {
  if (!isRecord(content) || content.v !== 1) {
    return { valid: false, reason: "unsupported-version" };
  }
  const agentUserId = content.agent_user_id;
  if (typeof agentUserId !== "string" || !isValidAgentUserId(agentUserId, ownerUserId)) {
    return { valid: false, reason: "invalid-agent-id" };
  }
  return { valid: true, agentUserId };
}

export function deriveRoomAvailability(
  room: StoredRoomEvents | undefined,
  ownerUserId: string,
): { unavailable: boolean; reason?: string; agentUserId?: string } {
  if (!room) {
    return { unavailable: false };
  }
  let hasTopicMarker = false;
  let topicMarkerContent: unknown;
  for (const event of room.stateEvents) {
    if (event.type === "im.waypoint.topic" && event.state_key === "") {
      hasTopicMarker = true;
      topicMarkerContent = event.content;
    }
  }
  if (!hasTopicMarker) {
    return { unavailable: false };
  }
  return deriveTopicAvailability(topicMarkerContent, room, ownerUserId);
}

function deriveTopicAvailability(
  topicMarkerContent: unknown,
  room: StoredRoomEvents,
  ownerUserId: string,
): { unavailable: boolean; reason?: string; agentUserId?: string } {
  const marker = parseTopicMarker(topicMarkerContent, ownerUserId);
  if (!marker.valid) {
    return {
      unavailable: true,
      reason:
        marker.reason === "unsupported-version"
          ? "因 Topic 标记版本不是 1，无法发送新消息。"
          : "因绑定的 Bot 用户 ID 不合法，无法发送新消息。",
    };
  }
  const agentUserId = marker.agentUserId;
  if (
    room.encryptedIrreversible ||
    room.stateEvents.some((ev) => ev.type === "m.room.encryption")
  ) {
    return {
      unavailable: true,
      reason: "因房间在创建后被加密，无法发送新消息。",
      agentUserId,
    };
  }

  let agentMembership: string | undefined;
  let hasExtraPerson = false;
  for (const event of room.stateEvents) {
    if (
      event.type !== "m.room.member" ||
      typeof event.state_key !== "string" ||
      !isRecord(event.content)
    ) {
      continue;
    }
    const membership = event.content.membership;
    if (event.state_key === agentUserId) {
      agentMembership = typeof membership === "string" ? membership : undefined;
    } else if (
      event.state_key !== ownerUserId &&
      (membership === "join" || membership === "invite")
    ) {
      hasExtraPerson = true;
    }
  }

  if (hasExtraPerson) {
    return {
      unavailable: true,
      reason: "因房间多于两人，无法发送新消息。",
      agentUserId,
    };
  }
  if (agentMembership === "ban") {
    return {
      unavailable: true,
      reason: "因绑定的 Bot 已被 ban，无法发送新消息。",
      agentUserId,
    };
  }
  if (
    room.inviteFailed ||
    (agentMembership !== undefined && agentMembership !== "join" && agentMembership !== "invite")
  ) {
    return {
      unavailable: true,
      reason: "因邀请绑定的 Bot 失败，无法发送新消息。",
      agentUserId,
    };
  }

  return { unavailable: false, agentUserId };
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
      message: disconnectedMessage("更新 Topic"),
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
      try {
        await client.rememberRoomStateEvents(input.roomId, [
          {
            type: eventType,
            state_key: "",
            origin_server_ts: input.now,
            ...(eventId ? { event_id: eventId } : {}),
            content,
          },
        ]);
      } catch {
        return {
          ok: false,
          message: "本地存储空间不足，未能保存 Topic 状态，请清理空间后重试。",
        };
      }
      return { ok: true };
    }
    return {
      ok: false,
      message: formatMatrixActionFailure(actionLabel, result, {
        serverErrorReason: "服务器暂时无法响应，请稍后重试。",
        rejectedReason: "服务器拒绝了该请求。",
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
  if (nameOutcome && !nameOutcome.ok && descriptionOutcome && !descriptionOutcome.ok) {
    if (nameOutcome.message === descriptionOutcome.message) {
      errors.push(nameOutcome.message);
    } else {
      errors.push(`更新 Topic 名字失败：${nameOutcome.message}`, `更新 Description 失败：${descriptionOutcome.message}`);
    }
  } else if (nameOutcome && !nameOutcome.ok) {
    errors.push(`更新 Topic 名字失败：${nameOutcome.message}`);
  } else if (descriptionOutcome && !descriptionOutcome.ok) {
    errors.push(`更新 Description 失败：${descriptionOutcome.message}`);
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

export type TimelinePromptOption = {
  key: string;
  label: string;
  scope?: string;
  redacted?: boolean;
};

export type TimelinePrompt = {
  kind: "approval" | "selector";
  options: TimelinePromptOption[];
  queuedKey?: string;
  selectedKey?: string;
  answered: boolean;
  superseded: boolean;
};

export type LocalAttachmentRef = {
  attachmentId: string;
  name: string;
  mimeType: string;
  size: number;
};

export type TimelineMedia = {
  kind: "image" | "file";
  msgtype: "m.image" | "m.file" | "m.audio" | "m.video";
  mxcUrl?: string;
  externalUrl?: string;
  filename: string;
  caption?: string;
  mimeType?: string;
  size?: number;
  localAttachment?: LocalAttachmentRef;
};

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
      media?: TimelineMedia;
      status: "confirmed" | "unconfirmed" | "failed";
      localId?: string;
      responding?: boolean;
      reactions?: string[];
      prompt?: TimelinePrompt;
    };

function isSafeHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function extractMediaFromContent(
  content: Record<string, unknown>,
  localAttachment?: LocalAttachmentRef,
): TimelineMedia | undefined {
  const msgtype = content.msgtype;
  if (
    msgtype !== "m.image" &&
    msgtype !== "m.file" &&
    msgtype !== "m.audio" &&
    msgtype !== "m.video"
  ) {
    return undefined;
  }
  const rawUrl = typeof content.url === "string" ? content.url.trim() : "";
  const mxcUrl = rawUrl && parseMxcUri(rawUrl) ? rawUrl : undefined;
  const externalUrl = !mxcUrl && rawUrl && isSafeHttpUrl(rawUrl) ? rawUrl : undefined;
  if (!localAttachment && !mxcUrl && !externalUrl) {
    return undefined;
  }
  const kind: "image" | "file" =
    msgtype === "m.image" && (mxcUrl || localAttachment) ? "image" : "file";
  const rawBody = typeof content.body === "string" ? content.body : "";
  const rawFilename = typeof content.filename === "string" ? content.filename.trim() : "";
  const filename =
    rawFilename ||
    localAttachment?.name ||
    (rawBody.trim() !== "" ? rawBody.trim() : kind === "image" ? "image" : "file");
  const caption = rawBody.trim() !== "" && rawBody !== filename ? rawBody : undefined;
  const mimeType =
    isRecord(content.info) &&
    typeof content.info.mimetype === "string" &&
    content.info.mimetype.trim() !== ""
      ? content.info.mimetype
      : localAttachment?.mimeType;
  const size =
    isRecord(content.info) &&
    typeof content.info.size === "number" &&
    Number.isFinite(content.info.size)
      ? content.info.size
      : localAttachment?.size;
  return {
    kind,
    msgtype,
    ...(mxcUrl ? { mxcUrl } : {}),
    ...(externalUrl ? { externalUrl } : {}),
    filename,
    ...(caption ? { caption } : {}),
    ...(mimeType ? { mimeType } : {}),
    ...(size !== undefined ? { size } : {}),
    ...(localAttachment ? { localAttachment } : {}),
  };
}

function stripStreamingCursor(body: string): string {
  return body.replace(/ ?▉$/, "");
}

function buildLocalAttachmentRef(source: {
  attachmentId?: string;
  attachmentMeta?: { name: string; mimeType: string; size: number };
}): LocalAttachmentRef | undefined {
  if (!source.attachmentId || !source.attachmentMeta) {
    return undefined;
  }
  return {
    attachmentId: source.attachmentId,
    name: source.attachmentMeta.name,
    mimeType: source.attachmentMeta.mimeType,
    size: source.attachmentMeta.size,
  };
}

const INLINE_PREVIEW_HTML_TAG_RE =
  /<\/?(?:span|font|b|strong|i|em|u|s|del|code|kbd|sub|sup|mark)\b[^>]*>/gi;
const CALLOUT_HEADER_RE = /^\[!(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/i;

/** Formats message body text into a single-line plain-text summary for the Topic list. */
export function formatMessagePreviewText(rawBody: string): string {
  const normalized = rawBody
    .replace(/\r\n?/g, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(INLINE_PREVIEW_HTML_TAG_RE, "");

  const keptLines: string[] = [];
  for (const rawLine of normalized.split("\n")) {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      continue;
    }
    if (
      /^(?:```|~~~).*$/.test(trimmed) ||
      /^:::\s*[\w-]*$/.test(trimmed) ||
      /^([-*_])(?:\s*\1){2,}$/.test(trimmed) ||
      /^\[[^\]]+\]:\s+\S+/.test(trimmed)
    ) {
      continue;
    }
    const line = rawLine
      .replace(/^(?:\s*>\s?)+/, "")
      .replace(CALLOUT_HEADER_RE, "")
      .replace(/^\s{0,3}#{1,6}\s+/, "")
      .replace(/\s+#+\s*$/, "")
      .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, "")
      .trim();
    if (line) {
      keptLines.push(line);
    }
  }

  let text = keptLines.join(" ");
  text = text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, (_m, alt: string) =>
      alt.trim() ? alt.trim() : "[图片]",
    )
    .replace(/!\[([^\]]*)\]\[[^\]]*\]/g, (_m, alt: string) =>
      alt.trim() ? alt.trim() : "[图片]",
    )
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1")
    .replace(/`+([^`]+)`+/g, "$1")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(/\*\*\*([^*]+)\*\*\*/g, "$1")
    .replace(/___([^_]+)___/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\*([^*\s][^*]*?)\*/g, "$1")
    .replace(/(^|\s)_([^_\s][^_]*?)_(?=\s|$|[.,!?;:)"'\]])/g, "$1$2")
    .replace(/\\([\\`*_{}[\]()#+\-.!~>])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();

  if (text) {
    return text;
  }
  return rawBody.replace(/\s+/g, " ").trim();
}

function formatMediaPreview(media: TimelineMedia): string {
  const caption = media.caption ? formatMessagePreviewText(media.caption) : "";
  if (media.msgtype === "m.image") {
    return caption ? `[图片] ${caption}` : "[图片]";
  }
  if (media.msgtype === "m.file") {
    return media.filename ? `[文件] ${media.filename}` : "[文件]";
  }
  const explicitFilename =
    media.filename && media.filename !== "file" && media.filename !== "image"
      ? media.filename
      : "";
  const label = media.msgtype === "m.audio" ? "[音频]" : "[视频]";
  const detail = caption || explicitFilename;
  return detail ? `${label} ${detail}` : label;
}

function extractLocalEventPreview(
  content: unknown,
  attachmentSource: {
    attachmentId?: string;
    attachmentMeta?: { name: string; mimeType: string; size: number };
  },
): string | undefined {
  if (!isRecord(content)) {
    return undefined;
  }
  const media = extractMediaFromContent(content, buildLocalAttachmentRef(attachmentSource));
  if (media) {
    return formatMediaPreview(media);
  }
  if (
    content.msgtype === "m.text" &&
    typeof content.body === "string" &&
    content.body.trim() !== ""
  ) {
    return formatMessagePreviewText(content.body);
  }
  return undefined;
}

/** Derives the single-line plain-text preview of the latest renderable message on a room's local timeline. */
export function deriveLatestMessagePreview(
  room: Pick<StoredRoomEvents, "timelineEvents"> | undefined,
  pendingEvents: PendingRoomEvent[],
  ownerUserId: string,
  agentUserId: string | undefined,
  precomputedRedactedIds?: Set<string>,
): string | undefined {
  const events = room?.timelineEvents ?? [];
  const seenLocalTxnIds = new Set<string>();
  for (const event of events) {
    const local = localPlaceholderOf(event);
    if (local) {
      seenLocalTxnIds.add(local.txnId);
    }
  }

  for (let i = pendingEvents.length - 1; i >= 0; i -= 1) {
    const pending = pendingEvents[i]!;
    if (seenLocalTxnIds.has(pending.txnId) || pending.type !== "m.room.message") {
      continue;
    }
    const preview = extractLocalEventPreview(pending.content, pending);
    if (preview !== undefined) {
      return preview;
    }
  }

  if (events.length === 0) {
    return undefined;
  }

  const redactedIds = precomputedRedactedIds ?? collectRedactedEventIds(events);
  const latestEdits = collectLatestEdits(events, redactedIds);

  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!;
    if (
      typeof event.state_key === "string" ||
      isRedactedEvent(event, redactedIds) ||
      !isActivityMessageEvent(event)
    ) {
      continue;
    }
    const local = localPlaceholderOf(event);
    if (local) {
      const preview = extractLocalEventPreview(event.content, local);
      if (preview !== undefined) {
        return preview;
      }
      continue;
    }
    const sender = typeof event.sender === "string" ? event.sender : undefined;
    if (sender !== ownerUserId && !(agentUserId && sender === agentUserId)) {
      continue;
    }
    if (!isRecord(event.content)) {
      continue;
    }
    const media = extractMediaFromContent(event.content);
    if (media) {
      return formatMediaPreview(media);
    }
    if (event.content.msgtype !== "m.text" || typeof event.content.body !== "string") {
      continue;
    }
    const rawEventId =
      typeof event.event_id === "string" && event.event_id !== "" ? event.event_id : undefined;
    const edit = rawEventId ? latestEdits.get(rawEventId) : undefined;
    const rawBody = edit ? edit.body : event.content.body;
    const body = edit || sender === agentUserId ? stripStreamingCursor(rawBody) : rawBody;
    if (body.trim() === "") {
      continue;
    }
    return formatMessagePreviewText(body);
  }

  return undefined;
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
    const eyesTargetIds = collectActiveEyesTargetIds(room.timelineEvents, redactedIds, agentUserId);
    const { promptsByEventId, hiddenReactionKeysByEventId } = collectMessagePrompts(
      room.timelineEvents,
      redactedIds,
      latestEdits,
      pendingEvents,
      ownerUserId,
      agentUserId,
    );
    const reactionsByEventId = collectMessageReactions(
      room.timelineEvents,
      redactedIds,
      ownerUserId,
      agentUserId,
      hiddenReactionKeysByEventId,
    );
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
        if (!isRecord(event.content)) {
          return;
        }
        const localAttachmentRef: LocalAttachmentRef | undefined =
          local.attachmentId && local.attachmentMeta
            ? {
                attachmentId: local.attachmentId,
                name: local.attachmentMeta.name,
                mimeType: local.attachmentMeta.mimeType,
                size: local.attachmentMeta.size,
              }
            : undefined;
        const media = extractMediaFromContent(event.content, localAttachmentRef);
        if (media) {
          items.push({
            kind: "message",
            key: `local-${local.id}`,
            side: "right",
            body: media.caption ?? media.filename,
            media,
            status: local.status,
            localId: local.id,
          });
          return;
        }
        if (
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
      if (!isRecord(event.content)) {
        return;
      }
      const rawEventId =
        typeof event.event_id === "string" && event.event_id !== ""
          ? event.event_id
          : undefined;
      const media = extractMediaFromContent(event.content);
      let body: string;
      if (!media) {
        if (
          event.content.msgtype !== "m.text" ||
          typeof event.content.body !== "string"
        ) {
          return;
        }
        const edit = rawEventId ? latestEdits.get(rawEventId) : undefined;
        const rawBody = edit ? edit.body : event.content.body;
        body = edit || side === "left" ? stripStreamingCursor(rawBody) : rawBody;
        if (body.trim() === "") {
          return;
        }
      } else {
        body = media.caption ?? media.filename;
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
      const reactions = rawEventId ? reactionsByEventId.get(rawEventId) : undefined;
      const prompt = rawEventId ? promptsByEventId.get(rawEventId) : undefined;
      items.push({
        kind: "message",
        key: eventId,
        eventId: rawEventId,
        side,
        body,
        ...(media ? { media } : {}),
        status: "confirmed",
        ...(rawEventId && eyesTargetIds.has(rawEventId) ? { responding: true } : {}),
        ...(reactions && reactions.length > 0 ? { reactions } : {}),
        ...(prompt ? { prompt } : {}),
      });
    });
  }

  for (const pending of pendingEvents) {
    if (seenLocalTxnIds.has(pending.txnId)) {
      continue;
    }
    if (pending.type !== "m.room.message") {
      continue;
    }
    const pendingLocalRef: LocalAttachmentRef | undefined =
      pending.attachmentId && pending.attachmentMeta
        ? {
            attachmentId: pending.attachmentId,
            name: pending.attachmentMeta.name,
            mimeType: pending.attachmentMeta.mimeType,
            size: pending.attachmentMeta.size,
          }
        : undefined;
    const media = extractMediaFromContent(pending.content, pendingLocalRef);
    if (media) {
      items.push({
        kind: "message",
        key: `pending-${pending.txnId}`,
        side: "right",
        body: media.caption ?? media.filename,
        media,
        status: "unconfirmed",
        localId: pending.txnId,
      });
      continue;
    }
    if (
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

function collectActiveEyesTargetIds(
  events: RawMatrixEvent[],
  redactedIds: Set<string>,
  agentUserId: string | undefined,
): Set<string> {
  const targets = new Set<string>();
  if (!agentUserId) {
    return targets;
  }
  for (const event of events) {
    if (
      typeof event.state_key === "string" ||
      localPlaceholderOf(event) ||
      isRedactedEvent(event, redactedIds) ||
      event.type !== "m.reaction" ||
      event.sender !== agentUserId ||
      !isRecord(event.content)
    ) {
      continue;
    }
    const relatesTo = event.content["m.relates_to"];
    if (
      !isRecord(relatesTo) ||
      relatesTo.rel_type !== "m.annotation" ||
      typeof relatesTo.event_id !== "string" ||
      relatesTo.event_id === "" ||
      redactedIds.has(relatesTo.event_id) ||
      relatesTo.key !== "👀"
    ) {
      continue;
    }
    targets.add(relatesTo.event_id);
  }
  return targets;
}

const APPROVAL_OPTIONS: ReadonlyArray<{
  canonicalKey: string;
  label: string;
  scope?: string;
}> = [
  { canonicalKey: "✅", label: "仅此次" },
  { canonicalKey: "🌀", label: "会话内允许", scope: "仅当前会话" },
  { canonicalKey: "♾", label: "始终允许", scope: "含该 Bot 的其他 Topic" },
  { canonicalKey: "❌", label: "拒绝" },
];

const APPROVAL_BY_KEY = new Map(APPROVAL_OPTIONS.map((opt) => [opt.canonicalKey, opt]));

const SELECTOR_LABELS: ReadonlyMap<string, string> = new Map([
  ["1\u20E3", "1"],
  ["2\u20E3", "2"],
  ["3\u20E3", "3"],
  ["4\u20E3", "4"],
  ["5\u20E3", "5"],
  ["6\u20E3", "6"],
  ["7\u20E3", "7"],
  ["8\u20E3", "8"],
  ["9\u20E3", "9"],
  ["🔟", "10"],
  ["🅰", "A"],
  ["🅱", "B"],
]);

export function normalizePromptReactionKey(key: string): string {
  return key.replace(/\uFE0F/g, "");
}

export function isPromptReactionKey(key: string): boolean {
  const canonical = normalizePromptReactionKey(key);
  return APPROVAL_BY_KEY.has(canonical) || SELECTOR_LABELS.has(canonical);
}

function collectMessagePrompts(
  events: RawMatrixEvent[],
  redactedIds: Set<string>,
  latestEdits: Map<string, { body: string; ts: number | undefined }>,
  pendingEvents: PendingRoomEvent[],
  ownerUserId: string,
  agentUserId: string | undefined,
): {
  promptsByEventId: Map<string, TimelinePrompt>;
  hiddenReactionKeysByEventId: Map<string, Set<string>>;
} {
  const promptsByEventId = new Map<string, TimelinePrompt>();
  const hiddenReactionKeysByEventId = new Map<string, Set<string>>();
  if (!agentUserId) {
    return { promptsByEventId, hiddenReactionKeysByEventId };
  }

  const agentMessageOrder = new Map<string, number>();
  events.forEach((event, index) => {
    if (event.sender !== agentUserId) {
      return;
    }
    if (!isRenderableTextBubbleEvent(event, redactedIds, latestEdits, agentUserId)) {
      return;
    }
    if (typeof event.event_id === "string" && event.event_id !== "") {
      agentMessageOrder.set(event.event_id, index);
    }
  });

  if (agentMessageOrder.size === 0) {
    return { promptsByEventId, hiddenReactionKeysByEventId };
  }

  type SeededEntry = { canonicalKey: string; rawKey: string; redacted: boolean };
  const approvalSeeded = new Map<string, Map<string, SeededEntry>>();
  const selectorSeeded = new Map<string, SeededEntry[]>();
  const ownerConfirmedByTarget = new Map<string, string[]>();

  for (const event of events) {
    if (
      typeof event.state_key === "string" ||
      localPlaceholderOf(event) ||
      event.type !== "m.reaction" ||
      !isRecord(event.content)
    ) {
      continue;
    }
    const sender = typeof event.sender === "string" ? event.sender : undefined;
    const relatesTo = event.content["m.relates_to"];
    if (
      !isRecord(relatesTo) ||
      relatesTo.rel_type !== "m.annotation" ||
      typeof relatesTo.event_id !== "string" ||
      relatesTo.event_id === "" ||
      redactedIds.has(relatesTo.event_id) ||
      !agentMessageOrder.has(relatesTo.event_id) ||
      typeof relatesTo.key !== "string" ||
      relatesTo.key === ""
    ) {
      continue;
    }
    const targetId = relatesTo.event_id;
    const rawKey = relatesTo.key;
    const canonicalKey = normalizePromptReactionKey(rawKey);
    const redacted = isRedactedEvent(event, redactedIds);

    if (sender === agentUserId) {
      if (APPROVAL_BY_KEY.has(canonicalKey)) {
        let map = approvalSeeded.get(targetId);
        if (!map) {
          map = new Map();
          approvalSeeded.set(targetId, map);
        }
        map.set(canonicalKey, { canonicalKey, rawKey, redacted });
      } else if (SELECTOR_LABELS.has(canonicalKey)) {
        let list = selectorSeeded.get(targetId);
        if (!list) {
          list = [];
          selectorSeeded.set(targetId, list);
        }
        const existing = list.find((entry) => entry.canonicalKey === canonicalKey);
        if (existing) {
          existing.rawKey = rawKey;
          existing.redacted = redacted;
        } else {
          list.push({ canonicalKey, rawKey, redacted });
        }
      }
    } else if (sender === ownerUserId && !redacted) {
      let list = ownerConfirmedByTarget.get(targetId);
      if (!list) {
        list = [];
        ownerConfirmedByTarget.set(targetId, list);
      }
      list.push(canonicalKey);
    }
  }

  const queuedCanonicalByTarget = new Map<string, string>();
  for (const pending of pendingEvents) {
    if (pending.type !== "m.reaction" || pending.sender !== ownerUserId) {
      continue;
    }
    const relatesTo = pending.content["m.relates_to"];
    if (
      !isRecord(relatesTo) ||
      relatesTo.rel_type !== "m.annotation" ||
      typeof relatesTo.event_id !== "string" ||
      !agentMessageOrder.has(relatesTo.event_id) ||
      typeof relatesTo.key !== "string" ||
      relatesTo.key === ""
    ) {
      continue;
    }
    queuedCanonicalByTarget.set(relatesTo.event_id, normalizePromptReactionKey(relatesTo.key));
  }

  let latestApprovalOrder = -1;
  let latestSelectorOrder = -1;

  for (const [targetId, order] of agentMessageOrder.entries()) {
    const approvals = approvalSeeded.get(targetId);
    const selectors = selectorSeeded.get(targetId);
    if (approvals && approvals.size >= 2) {
      latestApprovalOrder = Math.max(latestApprovalOrder, order);
    } else if (selectors && selectors.length > 0) {
      latestSelectorOrder = Math.max(latestSelectorOrder, order);
    }
  }

  for (const [targetId, order] of agentMessageOrder.entries()) {
    const approvals = approvalSeeded.get(targetId);
    const selectors = selectorSeeded.get(targetId);
    let kind: "approval" | "selector" | undefined;
    let options: TimelinePromptOption[] = [];

    if (approvals && approvals.size >= 2) {
      kind = "approval";
      for (const meta of APPROVAL_OPTIONS) {
        const entry = approvals.get(meta.canonicalKey);
        if (entry) {
          options.push({
            key: entry.rawKey,
            label: meta.label,
            ...(meta.scope ? { scope: meta.scope } : {}),
            ...(entry.redacted ? { redacted: true } : {}),
          });
        }
      }
    } else if (selectors && selectors.length > 0) {
      kind = "selector";
      options = selectors.map((entry) => ({
        key: entry.rawKey,
        label: SELECTOR_LABELS.get(entry.canonicalKey)!,
        ...(entry.redacted ? { redacted: true } : {}),
      }));
    }

    if (!kind || options.length === 0) {
      continue;
    }

    const optionByCanonical = new Map(
      options.map((opt) => [normalizePromptReactionKey(opt.key), opt]),
    );
    const hiddenSet = new Set(optionByCanonical.keys());
    hiddenReactionKeysByEventId.set(targetId, hiddenSet);

    const confirmedKeys = ownerConfirmedByTarget.get(targetId) ?? [];
    let confirmedOption: TimelinePromptOption | undefined;
    for (const canonical of confirmedKeys) {
      const match = optionByCanonical.get(canonical);
      if (match) {
        confirmedOption = match;
      }
    }

    const queuedCanonical = queuedCanonicalByTarget.get(targetId);
    const queuedOption = queuedCanonical ? optionByCanonical.get(queuedCanonical) : undefined;
    const answered = confirmedOption !== undefined;
    const superseded =
      kind === "approval" ? order < latestApprovalOrder : order < latestSelectorOrder;

    promptsByEventId.set(targetId, {
      kind,
      options,
      ...(confirmedOption !== undefined
        ? { selectedKey: confirmedOption.key }
        : queuedOption
          ? { queuedKey: queuedOption.key, selectedKey: queuedOption.key }
          : {}),
      answered,
      superseded,
    });
  }

  return { promptsByEventId, hiddenReactionKeysByEventId };
}

function collectMessageReactions(
  events: RawMatrixEvent[],
  redactedIds: Set<string>,
  ownerUserId: string,
  agentUserId: string | undefined,
  hiddenReactionKeysByEventId: Map<string, Set<string>>,
): Map<string, string[]> {
  const byTarget = new Map<string, string[]>();
  for (const event of events) {
    if (
      typeof event.state_key === "string" ||
      localPlaceholderOf(event) ||
      isRedactedEvent(event, redactedIds) ||
      event.type !== "m.reaction" ||
      !isRecord(event.content)
    ) {
      continue;
    }
    const sender = typeof event.sender === "string" ? event.sender : undefined;
    if (sender !== ownerUserId && !(agentUserId && sender === agentUserId)) {
      continue;
    }
    const relatesTo = event.content["m.relates_to"];
    if (
      !isRecord(relatesTo) ||
      relatesTo.rel_type !== "m.annotation" ||
      typeof relatesTo.event_id !== "string" ||
      relatesTo.event_id === "" ||
      redactedIds.has(relatesTo.event_id) ||
      typeof relatesTo.key !== "string" ||
      relatesTo.key === "" ||
      relatesTo.key === "👀"
    ) {
      continue;
    }
    const hiddenKeys = hiddenReactionKeysByEventId.get(relatesTo.event_id);
    if (hiddenKeys?.has(normalizePromptReactionKey(relatesTo.key))) {
      continue;
    }
    const list = byTarget.get(relatesTo.event_id) ?? [];
    if (!list.includes(relatesTo.key)) {
      list.push(relatesTo.key);
      byTarget.set(relatesTo.event_id, list);
    }
  }
  return byTarget;
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
  if (!isRecord(event.content)) {
    return false;
  }
  if (extractMediaFromContent(event.content)) {
    return true;
  }
  if (
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

function findFirstUnreadAgentEventAfterIndex(
  timelineEvents: RawMatrixEvent[],
  startIndex: number,
  agentUserId: string | undefined,
): { unread: boolean; firstUnreadEventId?: string; readPositionUnknown: boolean } {
  if (!agentUserId) {
    return { unread: false, readPositionUnknown: false };
  }
  const redactedIds = collectRedactedEventIds(timelineEvents);
  const latestEdits = collectLatestEdits(timelineEvents, redactedIds);
  for (let i = startIndex + 1; i < timelineEvents.length; i += 1) {
    const event = timelineEvents[i];
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

export function evaluateRoomUnreadFromEvents(
  timelineEvents: RawMatrixEvent[],
  readPositionEventId: string | undefined,
  agentUserId: string | undefined,
): { unread: boolean; firstUnreadEventId?: string; readPositionUnknown: boolean } {
  let startIndex = -1;
  if (readPositionEventId !== undefined) {
    startIndex = timelineEvents.findIndex(
      (event) => !localPlaceholderOf(event) && event.event_id === readPositionEventId,
    );
    if (startIndex === -1) {
      return { unread: false, readPositionUnknown: true };
    }
  }
  return findFirstUnreadAgentEventAfterIndex(timelineEvents, startIndex, agentUserId);
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
      if (room.coldUnreadState) {
        if (room.coldUnreadState.readPositionUnknown) {
          return { unread: false, readPositionUnknown: true };
        }
        if (room.coldUnreadState.unread) {
          return {
            unread: true,
            firstUnreadEventId: room.coldUnreadState.firstUnreadEventId,
            readPositionUnknown: false,
          };
        }
        startIndex = -1;
      } else {
        return { unread: false, readPositionUnknown: true };
      }
    }
  } else if (room.coldUnreadState?.unread) {
    return {
      unread: true,
      firstUnreadEventId: room.coldUnreadState.firstUnreadEventId,
      readPositionUnknown: false,
    };
  }
  return findFirstUnreadAgentEventAfterIndex(room.timelineEvents, startIndex, agentUserId);
}

export type BubbleVisibility = "above" | "visible" | "below";

export function hasLimitedGapAfterReadPosition(room: StoredRoomEvents | undefined): boolean {
  if (!room || room.timelineEvents.length === 0) {
    return false;
  }
  const events = room.timelineEvents;
  let startIndex = -1;
  if (room.readPositionEventId !== undefined) {
    startIndex = events.findIndex(
      (event) => !localPlaceholderOf(event) && event.event_id === room.readPositionEventId,
    );
    if (startIndex === -1) {
      return true;
    }
  }
  for (const gap of roomTimelineGaps(room)) {
    if (!gap.limited) {
      continue;
    }
    if (gap.pendingGapAtEnd) {
      return true;
    }
    if (gap.gapBeforeEventId) {
      const gapIdx = events.findIndex(
        (event) => !localPlaceholderOf(event) && event.event_id === gap.gapBeforeEventId,
      );
      if (gapIdx > startIndex && !(startIndex === -1 && gapIdx === 0)) {
        return true;
      }
    }
  }
  return false;
}

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

  for (const gap of roomTimelineGaps(room)) {
    if (!gap.limited) {
      continue;
    }
    if (gap.gapBeforeEventId) {
      const gapIdx = events.findIndex(
        (event) => !localPlaceholderOf(event) && event.event_id === gap.gapBeforeEventId,
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
