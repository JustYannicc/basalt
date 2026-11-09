import { DatabaseSync } from "node:sqlite";

interface SqliteTransaction {
  get<T>(key: string): Promise<T | undefined>;
  get<T>(keys: string[]): Promise<Map<string, T>>;
  put(key: string, value: unknown): Promise<void>;
  put(entries: Record<string, unknown>): Promise<void>;
  delete(key: string | string[]): Promise<void>;
}

/** ChunkStorage detects native batch overloads through transaction(), so this double implements them. */
export class RuntimeSqlite implements SqliteTransaction {
  private database = new DatabaseSync(":memory:");
  private queue: Promise<unknown> = Promise.resolve();
  private changed: string[] = [];
  afterCommit: (keys: readonly string[]) => void = () => {};
  constructor() {
    this.database.exec("CREATE TABLE storage (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  }
  private read<T>(key: string): T | undefined {
    const row = this.database.prepare("SELECT value FROM storage WHERE key = ?").get(key);
    return row ? (JSON.parse(String(row.value)) as T) : undefined;
  }
  private readInput(input: string | string[]) {
    if (typeof input === "string") return this.read(input);
    return new Map(
      input.flatMap((key) => {
        const value = this.read(key);
        return value === undefined ? [] : [[key, value] as const];
      }),
    );
  }
  private write(key: string, value: unknown) {
    this.changed.push(key);
    this.database
      .prepare(
        "INSERT INTO storage VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, JSON.stringify(value));
  }
  private getDirect<T>(key: string): Promise<T | undefined>;
  private getDirect<T>(keys: string[]): Promise<Map<string, T>>;
  private async getDirect(input: string | string[]) {
    return this.readInput(input);
  }
  private putDirect(key: string, value: unknown): Promise<void>;
  private putDirect(entries: Record<string, unknown>): Promise<void>;
  private async putDirect(input: string | Record<string, unknown>, value?: unknown) {
    if (typeof input === "string") this.write(input, value);
    else for (const [key, entry] of Object.entries(input)) this.write(key, entry);
  }
  private async deleteDirect(input: string | string[]) {
    for (const key of typeof input === "string" ? [input] : input) {
      this.changed.push(key);
      this.database.prepare("DELETE FROM storage WHERE key = ?").run(key);
    }
  }
  get<T>(key: string): Promise<T | undefined>;
  get<T>(keys: string[]): Promise<Map<string, T>>;
  async get(input: string | string[]) {
    await this.queue;
    return this.readInput(input);
  }
  put(key: string, value: unknown): Promise<void>;
  put(entries: Record<string, unknown>): Promise<void>;
  async put(input: string | Record<string, unknown>, value?: unknown) {
    await this.transaction(async () => {
      if (typeof input === "string") await this.putDirect(input, value);
      else await this.putDirect(input);
    });
  }
  async delete(input: string | string[]) {
    await this.transaction(() => this.deleteDirect(input));
  }
  async getAlarm() {
    return (await this.get<number>("fixture-alarm")) ?? null;
  }
  async setAlarm(at: number) {
    await this.put("fixture-alarm", at);
  }
  transaction<T>(work: (transaction: SqliteTransaction) => Promise<T>) {
    const pending = this.queue.then(async () => {
      this.database.exec("BEGIN IMMEDIATE");
      this.changed = [];
      let result: T;
      try {
        result = await work({
          get: this.getDirect.bind(this),
          put: this.putDirect.bind(this),
          delete: this.deleteDirect.bind(this),
        });
        this.database.exec("COMMIT");
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
      this.afterCommit(this.changed);
      return result;
    });
    this.queue = pending.catch(() => {});
    return pending;
  }
  async close() {
    await this.queue;
    this.database.close();
  }
}
