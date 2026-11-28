import type { TransactionStorage } from "./storage.ts";
import type { DrainExecutor } from "./legacy-drain.ts";

/** Narrow platform boundary shared by the local controller runtime and its private sibling DO. */
export interface RuntimeState {
  id: { toString(): string };
  storage: {
    get<T>(key: string): Promise<T | undefined>;
    put<T>(key: string, value: T): Promise<void>;
    getAlarm(): Promise<number | null>;
    setAlarm(at: number): Promise<void>;
  };
  container?: {
    readonly running: boolean;
    start(options: { enableInternet: boolean; env: Record<string, string> }): void;
    destroy(): Promise<void>;
    signal?(signal: number): void;
    monitor(): Promise<void>;
    setInactivityTimeout(milliseconds: number): Promise<void>;
    getTcpPort(port: number): {
      fetch(input: string | Request, init?: RequestInit): Promise<Response>;
    };
    exec?: DrainExecutor["exec"];
  };
  waitUntil(work: Promise<unknown>): void;
  /** Resets the object onto the deployed code. A state scoped over another object's has none. */
  abort?(reason: string): void;
}
/**
 * A runtime Durable Object's own storage. A state scoped over another object's storage never has it,
 * so nothing but the object that owns an alarm can drop it.
 */
export interface OwnedRuntimeStorage {
  delete(key: string): Promise<unknown>;
  deleteAlarm(): Promise<void>;
}
export interface ControllerState extends RuntimeState {
  storage: RuntimeState["storage"] & TransactionStorage;
}
