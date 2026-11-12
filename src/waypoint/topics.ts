export type BotRosterEntry = {
  userId: string;
  handwrittenName?: string;
};

export type StoredMemberState = {
  membership: string;
  displayname?: string;
};

export type StoredRoomRecord = {
  roomId: string;
  name?: string;
  description?: string;
  hasTopicMarker: boolean;
  topicMarker?: unknown;
  encrypted: boolean;
  members: Record<string, StoredMemberState>;
  createdAt?: number;
  lastMessageTs?: number;
};

export type TopicSummary = {
  roomId: string;
  name: string;
  description?: string;
  agentUserId?: string;
  botDisplayName?: string;
  unavailableReason?: string;
  lastActivityTs?: number;
};

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

export function parseBotRoster(content: unknown, ownerUserId: string): BotRosterEntry[] {
  if (!isRecord(content) || !Array.isArray(content.agents)) {
    return [];
  }
  const seen = new Set<string>();
  const roster: BotRosterEntry[] = [];
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
    roster.push({ userId, handwrittenName });
  }
  return roster;
}

export function resolveBotName(
  agentUserId: string,
  roster: BotRosterEntry[],
  roomMembers?: Record<string, StoredMemberState>,
): string {
  const rosterEntry = roster.find((entry) => entry.userId === agentUserId);
  if (rosterEntry?.handwrittenName) {
    return rosterEntry.handwrittenName;
  }
  const memberDisplayName = roomMembers?.[agentUserId]?.displayname;
  if (memberDisplayName) {
    return memberDisplayName;
  }
  return localpartOf(agentUserId);
}

export function mergeSyncRooms(
  current: Record<string, StoredRoomRecord>,
  body: unknown,
  incremental: boolean,
): Record<string, StoredRoomRecord> {
  const next: Record<string, StoredRoomRecord> = incremental ? { ...current } : {};
  if (!isRecord(body) || !isRecord(body.rooms)) {
    return next;
  }

  const joinRooms = body.rooms.join;
  if (isRecord(joinRooms)) {
    for (const [roomId, roomSync] of Object.entries(joinRooms)) {
      if (!isRecord(roomSync)) {
        continue;
      }
      const existing = next[roomId];
      const record: StoredRoomRecord = existing
        ? {
            ...existing,
            members: { ...existing.members },
          }
        : {
            roomId,
            hasTopicMarker: false,
            encrypted: false,
            members: {},
          };

      const stateEvents =
        isRecord(roomSync.state) && Array.isArray(roomSync.state.events) ? roomSync.state.events : [];
      for (const event of stateEvents) {
        applyStateEvent(record, event);
      }

      const timelineEvents =
        isRecord(roomSync.timeline) && Array.isArray(roomSync.timeline.events)
          ? roomSync.timeline.events
          : [];
      for (const event of timelineEvents) {
        if (!isRecord(event)) {
          continue;
        }
        if (typeof event.state_key === "string") {
          applyStateEvent(record, event);
        } else if (isActivityMessageEvent(event)) {
          const ts = validTimestamp(event.origin_server_ts);
          if (ts !== undefined) {
            record.lastMessageTs =
              record.lastMessageTs !== undefined ? Math.max(record.lastMessageTs, ts) : ts;
          }
        }
      }

      next[roomId] = record;
    }
  }

  const leaveRooms = body.rooms.leave;
  if (isRecord(leaveRooms)) {
    for (const roomId of Object.keys(leaveRooms)) {
      delete next[roomId];
    }
  }

  return next;
}

function applyStateEvent(record: StoredRoomRecord, event: unknown): void {
  if (!isRecord(event) || typeof event.type !== "string" || typeof event.state_key !== "string") {
    return;
  }
  const { type, state_key: stateKey, content } = event;
  const ts = validTimestamp(event.origin_server_ts);

  if (type === "im.waypoint.topic" && stateKey === "") {
    record.hasTopicMarker = true;
    record.topicMarker = content;
    if (record.createdAt === undefined && ts !== undefined) {
      record.createdAt = ts;
    }
    return;
  }

  if (type === "m.room.create" && stateKey === "") {
    if (ts !== undefined) {
      record.createdAt = ts;
    }
    return;
  }

  if (type === "m.room.name" && stateKey === "") {
    record.name =
      isRecord(content) && typeof content.name === "string" && content.name.trim() !== ""
        ? content.name.trim()
        : undefined;
    return;
  }

  if (type === "m.room.topic" && stateKey === "") {
    record.description =
      isRecord(content) && typeof content.topic === "string" && content.topic.trim() !== ""
        ? content.topic.trim()
        : undefined;
    return;
  }

  if (type === "m.room.encryption" && stateKey === "") {
    record.encrypted = true;
    return;
  }

  if (type === "m.room.member" && stateKey !== "") {
    const membership =
      isRecord(content) && typeof content.membership === "string" ? content.membership : "leave";
    const displayname =
      isRecord(content) && typeof content.displayname === "string" && content.displayname.trim() !== ""
        ? content.displayname.trim()
        : undefined;
    record.members[stateKey] = { membership, displayname };
  }
}

function isActivityMessageEvent(event: Record<string, unknown>): boolean {
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

export function deriveTopics(
  rooms: Record<string, StoredRoomRecord>,
  roster: BotRosterEntry[],
  ownerUserId: string,
): TopicSummary[] {
  const topics: TopicSummary[] = [];

  for (const room of Object.values(rooms)) {
    if (!room.hasTopicMarker) {
      continue;
    }
    const marker = parseTopicMarker(room.topicMarker, ownerUserId);
    const agentUserId = marker.valid ? marker.agentUserId : undefined;
    const botDisplayName = agentUserId ? resolveBotName(agentUserId, roster, room.members) : undefined;
    const unavailableReason = computeUnavailableReason(room, marker, ownerUserId);
    const lastActivityTs = room.lastMessageTs ?? room.createdAt;

    topics.push({
      roomId: room.roomId,
      name: room.name ?? "未命名 Topic",
      description: room.description,
      agentUserId,
      botDisplayName,
      unavailableReason,
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

function computeUnavailableReason(
  room: StoredRoomRecord,
  marker: { valid: true; agentUserId: string } | { valid: false },
  ownerUserId: string,
): string | undefined {
  if (room.encrypted) {
    return "因房间已加密不可用，无法发送新消息。";
  }
  if (!marker.valid) {
    return "因 Topic 标记无法识别不可用，无法发送新消息。";
  }
  const extraActiveMembers = Object.entries(room.members).some(([userId, member]) => {
    if (userId === ownerUserId || userId === marker.agentUserId) {
      return false;
    }
    return member.membership === "join" || member.membership === "invite" || member.membership === "knock";
  });
  if (extraActiveMembers) {
    return "因房间多于两人不可用，无法发送新消息。";
  }
  const agentMembership = room.members[marker.agentUserId]?.membership;
  if (agentMembership === "ban" || agentMembership === "leave") {
    return "因 Bot 无法加入不可用，无法发送新消息。";
  }
  return undefined;
}

export function resolvePreselectedBotId(
  topics: TopicSummary[],
  roster: BotRosterEntry[],
): string {
  if (roster.length <= 1 || topics.length === 0) {
    return "";
  }
  const latest = topics[0];
  if (latest.lastActivityTs === undefined || !latest.agentUserId) {
    return "";
  }
  return roster.some((bot) => bot.userId === latest.agentUserId) ? latest.agentUserId : "";
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

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
