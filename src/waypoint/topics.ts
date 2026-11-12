import type { TransportResult } from "../adapters/types";
import type { MatrixClient } from "./matrix-client";
import { formatMatrixActionFailure, isRecord } from "./matrix-errors";
import type { RawMatrixEvent, StoredRoomEvents } from "./session-store";

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
};

export type CreateTopicResult =
  | { ok: true; roomId: string }
  | { ok: false; message: string };

const directAppendQueues = new WeakMap<MatrixClient, Promise<void>>();

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
  for (const room of rooms) {
    const memberDisplayName = findMemberDisplayName(room.stateEvents, agentUserId);
    if (memberDisplayName) {
      return memberDisplayName;
    }
  }
  return localpartOf(agentUserId);
}

function findMemberDisplayName(stateEvents: RawMatrixEvent[], userId: string): string | undefined {
  for (let i = stateEvents.length - 1; i >= 0; i -= 1) {
    const event = stateEvents[i];
    if (event.type === "m.room.member" && event.state_key === userId && isRecord(event.content)) {
      const displayname = event.content.displayname;
      if (typeof displayname === "string" && displayname.trim() !== "") {
        return displayname.trim();
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
): TopicSummary[] {
  const topics: TopicSummary[] = [];

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

    let lastMessageTs: number | undefined;
    for (const event of room.timelineEvents) {
      if (typeof event.state_key === "string") {
        continue;
      }
      if (isActivityMessageEvent(event)) {
        const ts = validTimestamp(event.origin_server_ts);
        if (ts !== undefined) {
          lastMessageTs = lastMessageTs !== undefined ? Math.max(lastMessageTs, ts) : ts;
        }
      }
    }

    const marker = parseTopicMarker(topicMarkerContent, ownerUserId);
    const agentUserId = marker.valid ? marker.agentUserId : undefined;
    const botDisplayName = agentUserId
      ? resolveBotName(agentUserId, registeredAgents, room)
      : undefined;
    const lastActivityTs = lastMessageTs ?? createTs ?? markerTs;

    topics.push({
      roomId,
      name: name ?? "未命名 Topic",
      description,
      agentUserId,
      botDisplayName,
      lastActivityTs,
    });
  }

  topics.sort((left, right) => {
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

  await client.rememberCreatedRoom(roomId, initialStateEvents);
  return { ok: true, roomId };
}

export function appendDirectRoom(
  client: MatrixClient,
  agentUserId: string,
  roomId: string,
): Promise<void> {
  const prev = directAppendQueues.get(client) ?? Promise.resolve();
  const next = prev
    .catch(() => undefined)
    .then(async () => {
      if (!client.hasToken || !client.ownerId) {
        return;
      }
      const nextDirect = appendDirectRoomMapping(
        client.accountData("m.direct"),
        agentUserId,
        roomId,
      );
      try {
        const result = await client.putAccountData("m.direct", nextDirect);
        if (result.type === "response" && result.status >= 200 && result.status < 300) {
          await client.retainAccountData("m.direct", nextDirect);
        }
      } catch {
        // Best-effort per ADR-0023: never fail or roll back created Topic
      }
    });
  directAppendQueues.set(client, next);
  return next;
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
  const latest = topics[0];
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
