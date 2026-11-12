import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { performance } from "node:perf_hooks";
import type { NativeServices } from "./native-service-peer.ts";

const now = () => performance.timeOrigin + performance.now();
export interface PeerRecord {
  id: string;
  gateway: string;
  protocol: string;
  receivedAt: number;
  firstSentAt?: number;
  terminalSentAt?: number;
  endedAt?: number;
  thinkingMs: number;
  streamMs: number;
  initialStart?: boolean;
  level?: number;
  cancelled?: boolean;
  sentWireBytes?: number;
  burstWireBytes?: number;
  textPayloadBytes?: number;
}
export function scalePeer() {
  const records = new Map<string, PeerRecord>();
  const active = new Map<string, number>();
  const peak = new Map<string, number>();
  const waiters = new Set<() => void>();
  const notify = () => {
    for (const wake of waiters) wake();
  };
  const services: NativeServices = async ({ body, operation, signal }) => {
    if (operation.transport === "websocket" && !body) return { status: 101 };
    const input = JSON.parse(body) as {
      id: string;
      gateway: string;
      protocol: string;
      thinkingMs: number;
      streamMs: number;
      slow: boolean;
      probe: boolean;
      initialStart?: boolean;
      level?: number;
    };
    assert.equal(records.has(input.id), false, "Duplicate or replayed operation reached upstream.");
    const record: PeerRecord = { ...input, receivedAt: now() };
    records.set(input.id, record);
    active.set(input.gateway, (active.get(input.gateway) ?? 0) + 1);
    peak.set(input.gateway, Math.max(peak.get(input.gateway) ?? 0, active.get(input.gateway)!));
    notify();
    const finish = () => {
      if (record.endedAt) return;
      record.endedAt = now();
      record.cancelled = signal.aborted && !record.terminalSentAt;
      active.set(input.gateway, active.get(input.gateway)! - 1);
      notify();
    };
    try {
      await delay(input.thinkingMs, undefined, { signal });
      const messages = operation.path === "/v1/messages";
      const event = (type: string, fields: object = {}) => ({ type, ...fields });
      const response = { id: input.id, object: "response", status: "in_progress", output: [] };
      const message = {
        id: input.id,
        type: "message",
        role: "assistant",
        content: [],
        model: "synthetic",
        stop_reason: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      };
      const encode = (value: { type: string }) => {
        const bytes = Buffer.from(
          operation.transport === "websocket"
            ? JSON.stringify(value)
            : `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`,
        );
        record.sentWireBytes = (record.sentWireBytes ?? 0) + bytes.length;
        return bytes;
      };
      async function* chunks() {
        try {
          record.firstSentAt = now();
          yield encode(
            messages
              ? event("message_start", { message })
              : event("response.created", { response }),
          );
          if (messages)
            yield encode(
              event("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
            );
          const end = performance.now() + input.streamMs;
          let sequence = 0;
          let burst = input.slow ? 64 : 0;
          do {
            const text = "s".repeat(burst ? 15_000 : 512);
            const bytes = encode(
              messages
                ? event("content_block_delta", { index: 0, delta: { type: "text_delta", text } })
                : event("response.output_text.delta", {
                    response_id: input.id,
                    output_index: 0,
                    content_index: 0,
                    delta: text,
                    sequence_number: sequence++,
                  }),
            );
            record.textPayloadBytes = (record.textPayloadBytes ?? 0) + text.length;
            if (burst) record.burstWireBytes = (record.burstWireBytes ?? 0) + bytes.length;
            yield bytes;
            if (input.probe) break;
            if (burst) burst--;
            else await delay(1000, undefined, { signal });
          } while (performance.now() < end);
          if (messages) {
            yield encode(event("content_block_stop", { index: 0 }));
            yield encode(
              event("message_delta", {
                delta: { stop_reason: "end_turn", stop_sequence: null },
                usage: { output_tokens: 1 },
              }),
            );
          }
          record.terminalSentAt = now();
          yield encode(
            messages
              ? event("message_stop")
              : event("response.completed", { response: { ...response, status: "completed" } }),
          );
        } finally {
          finish();
        }
      }
      return { status: 200, headers: { "content-type": "text/event-stream" }, chunks: chunks() };
    } catch (error) {
      finish();
      throw error;
    }
  };
  return {
    services,
    records,
    active,
    peak,
    until: (predicate: () => boolean) =>
      new Promise<void>((resolve) => {
        if (predicate()) return resolve();
        const check = () => {
          if (predicate()) {
            waiters.delete(check);
            resolve();
          }
        };
        waiters.add(check);
      }),
  };
}
