import type { TransactionStorage } from "./storage.ts";

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
    setInactivityTimeout(milliseconds: number): Promise<void>;
    getTcpPort(port: number): {
      fetch(input: string | Request, init?: RequestInit): Promise<Response>;
    };
  };
  waitUntil(work: Promise<unknown>): void;
}
export interface ControllerState extends RuntimeState {
  storage: RuntimeState["storage"] & TransactionStorage;
}
