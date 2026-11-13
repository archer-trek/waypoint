import { expect, test } from "vitest";
import type { Clock, TransportResult } from "../adapters/types";
import type { MatrixClient } from "./matrix-client";
import type { PendingRoomEvent } from "./session-store";
import { RetryQueue } from "./retry-queue";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function clock(): Clock {
  return {
    setTimeout: () => 1,
    clearTimeout: () => {},
  };
}

test("队头发送尚未结束时入队的下一条，会在本轮失败退出后立刻继续送出 (#73)", async () => {
  const pending: PendingRoomEvent[] = [
    {
      txnId: "txn-1",
      roomId: "!room:example.com",
      type: "m.room.message",
      sender: "@owner:example.com",
      content: { msgtype: "m.text", body: "第一条" },
    },
  ];
  const sent: string[] = [];
  let firstAttempts = 0;
  const firstSend = deferred<TransportResult>();
  const client = {
    hasToken: true,
    pendingRoomEvents: () => pending.map((item) => ({ ...item, content: { ...item.content } })),
    pendingReadMarkers: () => [],
    sendRoomEvent: async (_roomId: string, _type: string, txnId: string) => {
      sent.push(txnId);
      if (txnId === "txn-1") {
        firstAttempts += 1;
        if (firstAttempts === 1) {
          return firstSend.promise;
        }
      }
      return { type: "response", status: 200, body: { event_id: `$ev-${txnId}` } };
    },
    confirmSentRoomEvent: async (_roomId: string, txnId: string) => {
      const index = pending.findIndex((item) => item.txnId === txnId);
      if (index !== -1) {
        pending.splice(index, 1);
      }
    },
    failPendingRoomEvent: async () => {},
    sendReadMarkers: async () => ({ type: "response", status: 200, body: {} }),
    confirmSentReadMarker: async () => {},
    uploadMedia: async () => ({ type: "response", status: 200, body: {} }),
    recordUploadedMediaUrl: async () => {},
  } as unknown as MatrixClient;

  const queue = new RetryQueue(client, clock());
  const firstFlush = queue.flush();
  await Promise.resolve();
  expect(sent).toEqual(["txn-1"]);

  pending.push({
    txnId: "txn-2",
    roomId: "!room:example.com",
    type: "m.room.message",
    sender: "@owner:example.com",
    content: { msgtype: "m.text", body: "第二条" },
  });
  const overlappedFlush = queue.flush();

  firstSend.resolve({ type: "failure", failure: { type: "network" } });
  await firstFlush;
  await overlappedFlush;
  for (let i = 0; i < 20 && sent.length < 3; i += 1) {
    await Promise.resolve();
  }

  expect(sent).toEqual(["txn-1", "txn-1", "txn-2"]);
  expect(pending.map((item) => item.txnId)).toEqual([]);
});
