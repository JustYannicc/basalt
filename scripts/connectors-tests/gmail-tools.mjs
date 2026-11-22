// Runs Gmail's tools exactly as Basalt's catalog serves them against the published Google
// emulator: attachments from an upload, a link and another message, a message past 5 MB through
// Gmail's resumable upload, and scheduled sends a person can list, move and cancel. Tool input
// goes through each operation's own decoder, as the host decodes it, so a field the package does
// not declare is dropped here as it is in production. The host's parts are played by this script:
// approvals (calls run approved), run controls, the durable timer and step retries, Human in the
// loop answers, the app's SQL (bun:sqlite with the package's migrations) and its cache. A front
// fills what the emulator lacks, as Google documents it (see front()).
// Everything is synthetic. Run with `bun scripts/connectors-tests/gmail-tools.mjs [gmail|google]`:
// the Gmail app, or the all-in-one Google app, which mounts the same tools under `gmail`.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { runDecoded } from "./run-decoded.ts";

const root = resolve(import.meta.dirname, "../..");
const { handleCatalog } = await import(join(root, "src/catalog/worker.ts"));
const packages = {
  gmail: { label: "Gmail", prefix: "", slot: "gmail" },
  google: { label: "Google", prefix: "gmail.", slot: "google" },
};
const packageId = process.argv[2] ?? "gmail";
const served = packages[packageId];
assert.ok(served, `Unknown package ${packageId}; use gmail or google`);
const published = await readFile(join(root, `src/catalog/${packageId}.published.json`), "utf8");
const me = "first@example.test";
const other = "second@example.test";
const token = "synthetic-gmail-token";
const scratch = await mkdtemp(join(tmpdir(), "basalt-gmail-tools-"));
const cleanups = [() => rm(scratch, { recursive: true, force: true })];

const freePort = async () => {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  await new Promise((done) => server.close(done));
  return port;
};

/** The emulator release the connector proofs use, installed from the committed lockfile. */
async function emulator() {
  const installation = join(scratch, "emulator");
  await mkdir(installation, { recursive: true });
  for (const file of ["package.json", "bun.lock"])
    await copyFile(join(root, "scripts/connectors-tests/emulator", file), join(installation, file));
  const install = spawnSync(
    "bun",
    ["install", "--cwd", installation, "--frozen-lockfile", "--ignore-scripts"],
    { encoding: "utf8" },
  );
  assert.equal(install.status, 0, `Installing the emulator failed: ${install.stderr}`);
  const packageRoot = join(installation, "node_modules/@executor-js/emulate");
  const metadata = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  assert.equal(metadata.version, "0.14.2");
  const bin = join(
    packageRoot,
    typeof metadata.bin === "string" ? metadata.bin : Object.values(metadata.bin)[0],
  );
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const seed = join(scratch, "google.json");
  await writeFile(
    seed,
    JSON.stringify({
      tokens: { [token]: { login: me, scopes: ["https://mail.google.com/"] } },
      google: {
        users: [me, other].map((email, i) => ({ email, name: `Synthetic user ${i + 1}` })),
      },
    }),
  );
  const child = spawn(
    process.execPath,
    [bin, "--service", "google", "--port", String(port), "--base-url", origin, "--seed", seed],
    {
      cwd: scratch,
      detached: true,
      env: { PATH: process.env.PATH, HOME: scratch, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let log = "";
  child.stdout.on("data", (data) => (log += data));
  child.stderr.on("data", (data) => (log += data));
  cleanups.unshift(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const closed = once(child, "close");
    process.kill(-child.pid, "SIGTERM");
    await closed;
  });
  for (const deadline = Date.now() + 30_000; Date.now() < deadline;) {
    if (
      await fetch(`${origin}/.well-known/openid-configuration`).then(
        (r) => r.ok,
        () => false,
      )
    )
      return origin;
    if (child.exitCode !== null) break;
    await new Promise((done) => setTimeout(done, 200));
  }
  throw new Error(`The Google emulator did not start:\n${log}`);
}

/**
 * What the emulator lacks, as Google documents it, in front of it: refusing a credential Google
 * would reject (the emulator accepts any bearer), the profile (users.getProfile, which names the
 * account), and the resumable upload, where the session takes the metadata and the PUT's exact
 * bytes go to the emulator's simple upload. Every other request passes through unchanged.
 */
function front(emulatorOrigin) {
  const requests = [];
  const sessions = new Map();
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const body = new Uint8Array(await request.arrayBuffer());
      const entry = {
        method: request.method,
        path: url.pathname,
        uploadType: url.searchParams.get("uploadType"),
        bytes: body.length,
      };
      requests.push(entry);
      const upload = url.searchParams.has("upload_id");
      if (!upload && request.headers.get("authorization") !== `Bearer ${token}`)
        return Response.json(
          { error: { code: 401, message: "Request had invalid authentication credentials." } },
          { status: 401 },
        );
      if (url.pathname === "/oauth2/v3/userinfo") return Response.json({ sub: "1", email: me });
      if (url.pathname === "/gmail/v1/users/me/profile")
        return Response.json({
          emailAddress: me,
          messagesTotal: 0,
          threadsTotal: 0,
          historyId: "1",
        });
      if (url.searchParams.get("uploadType") === "resumable" && url.searchParams.has("upload_id")) {
        const session = sessions.get(url.searchParams.get("upload_id"));
        if (!session || request.method !== "PUT")
          return new Response("Unknown upload session", { status: 404 });
        if (body.length !== session.length)
          return new Response("Length differs from X-Upload-Content-Length", { status: 400 });
        sessions.delete(url.searchParams.get("upload_id"));
        return fetch(`${emulatorOrigin}${url.pathname}?uploadType=media`, {
          method: "POST",
          headers: { authorization: session.authorization, "content-type": "message/rfc822" },
          body,
        });
      }
      if (url.searchParams.get("uploadType") === "resumable") {
        if (request.method !== "POST")
          return new Response("Start a session with POST", { status: 405 });
        if (request.headers.get("x-upload-content-type") !== "message/rfc822")
          return new Response("Wrong upload type", { status: 400 });
        const length = Number(request.headers.get("x-upload-content-length"));
        if (!(length > 0) || length > 36_700_160)
          return new Response("Bad upload length", { status: 400 });
        const id = crypto.randomUUID();
        entry.metadata = JSON.parse(new TextDecoder().decode(body) || "{}");
        sessions.set(id, { length, authorization: request.headers.get("authorization") ?? "" });
        return new Response(null, {
          status: 200,
          headers: {
            location: `https://gmail.googleapis.com${url.pathname}?uploadType=resumable&upload_id=${id}`,
          },
        });
      }
      const headers = new Headers(request.headers);
      headers.delete("host");
      const response = await fetch(`${emulatorOrigin}${url.pathname}${url.search}`, {
        method: request.method,
        headers,
        body: body.length ? body : undefined,
      });
      entry.status = response.status;
      return response;
    },
  });
  cleanups.unshift(async () => server.stop(true));
  return { origin: server.url.origin, requests };
}

// Files a link can point at, as a thread's or drive's download link serves them.
const report = new Uint8Array(Array.from({ length: 4096 }, (_, i) => (i * 31) % 256));
const big = new Uint8Array(6 * 1024 * 1024).map((_, i) => (i * 7) % 251);
const files = { "/report.pdf": report, "/big.bin": big };
const fileRequests = [];
const fileServer = Bun.serve({
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname;
    fileRequests.push({ path, authorization: request.headers.get("authorization") });
    if (path === "/too-big.bin") return new Response(new Uint8Array(26 * 1024 * 1024));
    // A plain filename is literal: its percent sign is not an escape.
    if (path === "/sale")
      return new Response(report, {
        headers: {
          "content-type": "application/pdf",
          "content-disposition": 'attachment; filename="50% off.pdf"',
        },
      });
    const bytes = files[path];
    if (!bytes) return new Response("Not found", { status: 404 });
    return new Response(bytes, {
      headers: {
        "content-type": path.endsWith(".pdf") ? "application/pdf" : "application/octet-stream",
      },
    });
  },
});
cleanups.unshift(async () => fileServer.stop(true));

const failures = [];
let gmailRequests = () => [];
/** Each feature is checked on its own, so a run reports every way the package fails. */
const check = async (name, run) => {
  try {
    await run();
    console.log(`ok - ${name}`);
  } catch (error) {
    failures.push(`${name}: ${error?.message ?? error}`);
    if (process.env.GMAIL_TOOLS_DEBUG)
      console.log(error?.stack, JSON.stringify(gmailRequests().slice(-5)));
    console.log(`not ok - ${name}: ${error?.message ?? error}`);
  }
};

try {
  const emulatorOrigin = await emulator();
  const gmail = front(emulatorOrigin);
  gmailRequests = () => gmail.requests;
  // Gmail and the file host as the host's network reaches them.
  const fetchVia = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const routed =
      url.origin === "https://gmail.googleapis.com" || url.origin === "https://www.googleapis.com"
        ? `${gmail.origin}${url.pathname}${url.search}`
        : url.origin === "https://files.example.test"
          ? `${fileServer.url.origin}${url.pathname}`
          : undefined;
    assert.ok(routed, `The package reached an unexpected host: ${url.origin}`);
    return fetch(routed, init);
  };
  const emulated = async (path, init = {}) => {
    const response = await fetch(`${emulatorOrigin}/gmail/v1/users/me${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...init.headers,
      },
    });
    return response.status === 204
      ? { status: 204 }
      : { status: response.status, ...(await response.json()) };
  };

  // The package as the catalog serves it; its publisher answers with the captured release.
  const response = await handleCatalog(
    new Request(`https://catalog.example.test/catalog/apps/${packageId}.json`),
    async () => new Response(published, { headers: { "content-type": "application/json" } }),
  );
  assert.equal(response.status, 200);
  const source = await response.json();
  const directory = await mkdtemp(join(root, ".upstream/packages/apps/.gmail-tools-"));
  cleanups.unshift(() => rm(directory, { recursive: true, force: true }));
  for (const file of source.files) {
    if (
      file.path === "package.json" ||
      file.path.endsWith(".test.ts") ||
      file.path.endsWith(".mjs")
    )
      continue;
    await mkdir(dirname(join(directory, file.path)), { recursive: true });
    await writeFile(join(directory, file.path), file.content);
  }
  const { nativeRouter, declaredOperations } = await import(
    join(root, ".upstream/packages/apps/src/implementation/router.ts")
  );
  const { nativeWorkflow } = await import(
    join(root, ".upstream/packages/apps/src/implementation/workflows.ts")
  );
  const app = (await import(join(directory, "index.ts"))).default;

  // App storage: SQLite with the package's own migrations, applied as the host applies them.
  const database = new Database(":memory:");
  for (const name of (await readdir(join(directory, "migrations")).catch(() => [])).sort())
    database.exec(await readFile(join(directory, "migrations", name), "utf8"));
  const cursor = (rows) => ({
    toArray: () => rows,
    one: () => (assert.equal(rows.length, 1), rows[0]),
    [Symbol.iterator]: () => rows[Symbol.iterator](),
  });
  const sql = {
    exec: (query, ...bindings) => cursor(database.query(query).all(...bindings)),
    transaction: (work) => database.transaction(() => work(sql))(),
  };
  const signal = new AbortController().signal;
  const memory = (scope = "") => {
    const values = new Map();
    const key = (value) => scope + JSON.stringify(value);
    const load = async (name, loader) => (
      values.set(key(name), await loader({ fetch: fetchVia, signal })),
      values.get(key(name))
    );
    return {
      get: async ({ key: name, load: loader }) =>
        values.has(key(name)) ? values.get(key(name)) : load(name, loader),
      revalidate: async ({ key: name, load: loader }) => load(name, loader),
      read: async (name) => values.get(key(name)),
      readMany: async (names) => names.map((name) => values.get(key(name))),
      write: async (entries) => entries.forEach((entry) => values.set(key(entry.key), entry.value)),
      invalidate: async (name) => values.delete(key(name)),
      forAccount: (account) => memory(`${scope}${account.id}/`),
    };
  };

  // Durable runs, started, read and ended as the host's controls do; runs advance only when told.
  const runs = new Map();
  let definition;
  const workflows = {
    start: async ({ workflow, input }) => {
      assert.ok(
        definition.workflows?.[workflow],
        `The package started an undeclared workflow: ${workflow}`,
      );
      const run = {
        id: `wfr_${runs.size + 1}`,
        app: "gmail",
        version: "1",
        workflow,
        createdAt: new Date().toISOString(),
        status: "waiting",
        input,
      };
      runs.set(run.id, run);
      return run;
    },
    get: async ({ run }) => runs.get(run) ?? Promise.reject(new Error("not_found")),
    list: async () => ({ items: [...runs.values()] }),
    terminate: async ({ run }) => Object.assign(runs.get(run), { status: "terminated" }),
  };
  const accountOf = (accessToken, id = "acc_first") => ({
    id,
    method: "oauth",
    fields: { access_token: accessToken },
  });
  const contextFor = (accounts) => ({
    user: { id: "person-1", accounts: { [served.slot]: accounts } },
    app: { accounts: {} },
    cache: memory(),
    files: [],
    workflows,
    elicit: async () => assert.fail("Tools must not ask interactively"),
    fetch: fetchVia,
    signal,
    sql,
    apps: { call: async () => assert.fail("No app calls") },
    events: { emit: async () => undefined },
  });
  const context = contextFor([accountOf(token)]);
  definition = await app.evaluate(context);
  const operationsFor = async (ctx) =>
    new Map(
      declaredOperations(nativeRouter((await app.evaluate(ctx)).tools)).map(
        ({ name, operation }) => [name, operation],
      ),
    );
  const operations = await operationsFor(context);
  /** An approved call, evaluated with the caller's accounts as the host does; input decoded by the operation's own schema. */
  const call = async (name, input, ctx = context) => {
    const operation = (await operationsFor(ctx)).get(served.prefix + name);
    assert.ok(operation, `${served.label} has no ${served.prefix}${name} tool`);
    return runDecoded(operation, ctx, input);
  };
  const failure = (promise) =>
    promise.then(
      () => assert.fail("Expected the call to fail"),
      (error) => `${error?.message ?? error} ${error?.cause?.message ?? ""}`,
    );
  const attachmentsOf = (message) => {
    const found = [];
    const walk = (part) => {
      if (part?.filename && part.body?.attachmentId)
        found.push({
          filename: part.filename,
          mimeType: part.mimeType,
          size: part.body.size,
          id: part.body.attachmentId,
        });
      for (const child of part?.parts ?? []) walk(child);
    };
    walk(message.payload);
    return found;
  };
  const bytesOf = async (messageId, attachmentId) =>
    new Uint8Array(
      Buffer.from(
        (await emulated(`/messages/${messageId}/attachments/${attachmentId}`)).data,
        "base64url",
      ),
    );
  const sentWith = async (subject) => {
    const { messages = [] } = await emulated("/messages?labelIds=SENT&maxResults=500");
    const read = await Promise.all(
      messages.map(({ id }) => emulated(`/messages/${id}?format=metadata&metadataHeaders=Subject`)),
    );
    return read.filter((message) =>
      message.payload?.headers?.some(
        (h) => h.name.toLowerCase() === "subject" && h.value === subject,
      ),
    );
  };
  const notes = "Agenda: ship it.\n";
  const inline = { filename: "notes.txt", contentBase64: Buffer.from(notes).toString("base64") };

  await check(
    "send and draft carry attachments from an upload, a link and another message",
    async () => {
      const sent = await call("send", {
        to: [other],
        subject: "Synthetic attachments",
        body: "Two files attached.",
        attachments: [
          inline,
          { url: "https://files.example.test/report.pdf" },
          { url: "https://files.example.test/sale" },
        ],
      });
      const attached = attachmentsOf(await emulated(`/messages/${sent.messageId}?format=full`));
      assert.deepEqual(
        attached.map(({ filename, mimeType, size }) => ({ filename, mimeType, size })),
        [
          { filename: "notes.txt", mimeType: "text/plain", size: notes.length },
          { filename: "report.pdf", mimeType: "application/pdf", size: report.length },
          { filename: "50% off.pdf", mimeType: "application/pdf", size: report.length },
        ],
        "send lost its attachments",
      );
      assert.equal(new TextDecoder().decode(await bytesOf(sent.messageId, attached[0].id)), notes);
      assert.deepEqual(await bytesOf(sent.messageId, attached[1].id), report);
      assert.ok(
        fileRequests.every((request) => request.authorization === null),
        "A credential went to the file link",
      );

      const draft = await call("draft", {
        to: [other],
        subject: "Synthetic forwarded file",
        body: "The report again.",
        attachments: [{ messageId: sent.messageId, attachmentId: attached[1].id }],
      });
      const saved = await emulated(`/drafts/${draft.draftId}?format=full`);
      const forwarded = attachmentsOf(saved.message);
      assert.deepEqual(
        forwarded.map(({ filename, size }) => ({ filename, size })),
        [{ filename: "report.pdf", size: report.length }],
        "draft lost its attachment",
      );
      assert.deepEqual(await bytesOf(saved.message.id, forwarded[0].id), report);
    },
  );

  await check("a message past 5 MB goes by Gmail's resumable upload", async () => {
    const before = gmail.requests.length;
    const large = await call("send", {
      to: [other],
      subject: "Synthetic large file",
      body: "Big one.",
      attachments: [{ url: "https://files.example.test/big.bin", filename: "big.bin" }],
    });
    const requests = gmail.requests.slice(before);
    assert.deepEqual(
      requests
        .filter((request) => request.path.startsWith("/upload/"))
        .map(({ method, path, uploadType }) => ({ method, path, uploadType })),
      [
        {
          method: "POST",
          path: "/upload/gmail/v1/users/me/messages/send",
          uploadType: "resumable",
        },
        { method: "PUT", path: "/upload/gmail/v1/users/me/messages/send", uploadType: "resumable" },
      ],
      "A large message did not use the resumable upload",
    );
    assert.ok(
      requests.every(
        (request) => request.path.startsWith("/upload/") || request.bytes <= 5 * 1024 * 1024,
      ),
      "A large message went as JSON",
    );
    const attached = attachmentsOf(await emulated(`/messages/${large.messageId}?format=full`));
    assert.deepEqual(
      attached.map(({ filename, size }) => ({ filename, size })),
      [{ filename: "big.bin", size: big.length }],
    );
    assert.deepEqual(await bytesOf(large.messageId, attached[0].id), big);

    // A large reply draft keeps its thread: the session's metadata carries it.
    const reply = await call("draft", {
      replyToMessageId: large.messageId,
      body: "Big one again.",
      attachments: [{ url: "https://files.example.test/big.bin", filename: "big.bin" }],
    });
    const session = gmail.requests.find(
      (request) => request.path === "/upload/gmail/v1/users/me/drafts" && request.method === "POST",
    );
    assert.deepEqual(
      session?.metadata,
      { message: { threadId: large.threadId } },
      "A large draft lost its thread",
    );
    const saved = await emulated(`/drafts/${reply.draftId}?format=full`);
    assert.deepEqual(
      attachmentsOf(saved.message).map(({ filename, size }) => ({ filename, size })),
      [{ filename: "big.bin", size: big.length }],
    );
  });

  await check("attachment limits are stated and refused before anything is sent", async () => {
    for (const name of ["send", "draft"])
      assert.match(
        operations.get(served.prefix + name)?.description ?? "",
        /attachments.*25 MB/s,
        `${name} does not say what it accepts`,
      );
    const sends = () =>
      gmail.requests.filter((request) => /messages\/send|drafts$/.test(request.path)).length;
    const before = sends();
    assert.match(
      await failure(
        call("send", {
          to: [other],
          subject: "Synthetic too big",
          body: "x",
          attachments: [{ url: "https://files.example.test/too-big.bin" }],
        }),
      ),
      /25 MB/,
    );
    assert.match(
      await failure(
        call("send", {
          to: [other],
          subject: "Synthetic sourceless",
          body: "x",
          attachments: [{ filename: "a.txt" }],
        }),
      ),
      /exactly one source/,
    );
    assert.match(
      await failure(
        call("send", {
          to: [other],
          subject: "Synthetic plain link",
          body: "x",
          attachments: [{ url: "http://files.example.test/report.pdf" }],
        }),
      ),
      /https/,
    );
    assert.equal(sends(), before, "A refused attachment still sent mail");
  });

  await check(
    "scheduled send waits as a draft that can be listed, moved and cancelled",
    async () => {
      const inHour = new Date(Date.now() + 3_600_000).toISOString();
      const scheduled = await call("send", {
        to: [other],
        subject: "Synthetic scheduled",
        body: "See you tomorrow.",
        sendAt: inHour,
        attachments: [inline],
      });
      assert.deepEqual(
        await sentWith("Synthetic scheduled"),
        [],
        "send with sendAt sent the email at once",
      );
      assert.ok(scheduled.draftId, "A scheduled email must wait as a draft");
      assert.equal(scheduled.sendAt, inHour);
      assert.equal((await emulated(`/drafts/${scheduled.draftId}`)).status, 200);
      const listed = await call("scheduled", {});
      assert.deepEqual(
        listed.scheduled.map(({ draftId, to, subject, sendAt, state }) => ({
          draftId,
          to,
          subject,
          sendAt,
          state,
        })),
        [
          {
            draftId: scheduled.draftId,
            to: other,
            subject: "Synthetic scheduled",
            sendAt: inHour,
            state: "scheduled",
          },
        ],
      );
      // Another person's accounts see none of it.
      const stranger = contextFor([accountOf("synthetic-other-token", "acc_other")]);
      stranger.cache.forAccount = () => ({ get: async () => other });
      assert.deepEqual((await call("scheduled", {}, stranger)).scheduled, []);

      const inTwo = new Date(Date.now() + 7_200_000).toISOString().replace(/\.\d+Z$/, "Z");
      const moved = await call("scheduleDraft", { draftId: scheduled.draftId, sendAt: inTwo });
      assert.equal(moved.replacedSchedules, 1);
      assert.equal(
        runs.get(scheduled.runId).status,
        "terminated",
        "Rescheduling left the first send waiting",
      );
      assert.deepEqual(
        (await call("scheduled", {})).scheduled.map(({ runId, sendAt }) => ({ runId, sendAt })),
        [{ runId: moved.runId, sendAt: new Date(inTwo).toISOString() }],
      );

      assert.equal((await call("cancelScheduled", { draftId: scheduled.draftId })).cancelled, 1);
      assert.deepEqual((await call("scheduled", {})).scheduled, []);
      assert.deepEqual(
        (await call("scheduled", { all: true })).scheduled.map(({ state }) => state),
        ["cancelled", "cancelled"],
      );
      assert.equal(
        (await emulated(`/drafts/${scheduled.draftId}`)).status,
        200,
        "Cancelling deleted the draft",
      );
      assert.match(
        await failure(call("cancelScheduled", { draftId: scheduled.draftId })),
        /No scheduled send/,
      );
      assert.match(
        await failure(
          call("send", { to: [other], subject: "x", body: "x", sendAt: "2020-01-01T00:00:00Z" }),
        ),
        /already passed/,
      );
      assert.match(
        await failure(
          call("scheduleDraft", {
            draftId: scheduled.draftId,
            sendAt: "2026-12-01T09:00",
            timeZone: "Mars/Olympus",
          }),
        ),
        /time zone/,
      );
    },
  );

  const runWorkflow = async (record, accounts, answer) => {
    const timers = [];
    const questions = [];
    const step = {
      do: async (name, options, work) => {
        const body = typeof options === "function" ? options : work;
        const limit = typeof options === "function" ? 0 : (options.retries?.limit ?? 0);
        for (let attempt = 0; ; attempt++) {
          try {
            return await body({
              ...contextFor(accounts),
              runId: record.id,
              stepId: name,
              idempotencyKey: `${record.id}:${name}`,
            });
          } catch (error) {
            if (error?.name === "NonRetryableError" || attempt >= limit) throw error;
          }
        }
      },
      sleep: async () => undefined,
      sleepUntil: async (name, at) => void timers.push({ name, at: Number(at) }),
      requestInput: async (name, request) => (
        questions.push({ name, request }),
        { id: `wfi_${"0".repeat(64)}`, status: "pending" }
      ),
      waitForInput: async () => answer,
    };
    const workflow = nativeWorkflow(definition.workflows[record.workflow]);
    const output = await runDecoded(workflow, { runId: record.id, step }, record.input);
    Object.assign(record, { status: "complete", output });
    return { output, timers, questions };
  };

  await check(
    "the workflow sends a scheduled draft at its time from the account that scheduled it",
    async () => {
      const draft = await call("draft", {
        to: [other],
        subject: "Synthetic at nine",
        body: "Morning.",
        attachments: [inline],
      });
      // A local time in a zone without daylight saving: 09:00 in Tokyo is midnight UTC.
      const day = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
      const local = await call("scheduleDraft", {
        draftId: draft.draftId,
        sendAt: `${day}T09:00`,
        timeZone: "Asia/Tokyo",
      });
      assert.equal(local.sendAt, `${day}T00:00:00.000Z`);
      const delivered = await runWorkflow(runs.get(local.runId), [accountOf(token)]);
      assert.deepEqual(delivered.timers, [
        { name: "wait for the send time", at: Date.parse(`${day}T00:00:00Z`) },
      ]);
      assert.deepEqual([delivered.output.outcome, delivered.questions.length], ["sent", 0]);
      const [out] = await sentWith("Synthetic at nine");
      assert.ok(out, "The scheduled email was not sent at its time");
      assert.deepEqual(
        attachmentsOf(await emulated(`/messages/${out.id}?format=full`)).map(
          ({ filename }) => filename,
        ),
        ["notes.txt"],
      );
      assert.equal(
        (await emulated(`/drafts/${draft.draftId}`)).status,
        404,
        "The sent draft is still in Drafts",
      );
      assert.equal(
        (await call("scheduled", { all: true })).scheduled.find(
          (item) => item.runId === local.runId,
        )?.state,
        "sent",
      );

      // A draft sent or deleted by hand ends the run quietly.
      const gone = await call("draft", { to: [other], subject: "Synthetic deleted", body: "x" });
      const goneRun = await call("scheduleDraft", {
        draftId: gone.draftId,
        sendAt: new Date(Date.now() + 86_400_000).toISOString(),
      });
      await emulated(`/drafts/${gone.draftId}`, { method: "DELETE" });
      const quiet = await runWorkflow(runs.get(goneRun.runId), [accountOf(token)]);
      assert.deepEqual([quiet.output.outcome, quiet.questions.length], ["gone", 0]);

      // When Gmail refuses, the person is asked through Human in the loop and the draft is kept.
      const refused = await call("draft", { to: [other], subject: "Synthetic refused", body: "x" });
      const refusedRun = await call("scheduleDraft", {
        draftId: refused.draftId,
        sendAt: new Date(Date.now() + 86_400_000).toISOString(),
      });
      const asked = await runWorkflow(
        runs.get(refusedRun.runId),
        [accountOf("synthetic-revoked-token")],
        {
          status: "answered",
          response: { action: "accept", content: { choice: "Keep it as a draft" } },
        },
      );
      assert.deepEqual([asked.output.outcome, asked.questions.length], ["kept", 1]);
      assert.match(
        asked.questions[0].request.form.message,
        /Synthetic refused.*was not sent: Gmail answered 401/,
      );
      assert.equal((await emulated(`/drafts/${refused.draftId}`)).status, 200);
      const states = new Map(
        (await call("scheduled", { all: true })).scheduled.map((item) => [item.runId, item.state]),
      );
      assert.deepEqual(
        [states.get(goneRun.runId), states.get(refusedRun.runId)],
        ["draft gone", "kept as draft"],
      );
    },
  );
} finally {
  for (const cleanup of cleanups) await cleanup().catch(() => undefined);
}
if (failures.length) {
  console.error(
    `${packageId} package: Gmail checks failed against the published Google emulator:\n- ${failures.join("\n- ")}`,
  );
  process.exit(1);
}
console.log(
  `${packageId} package: Gmail attachment and scheduled-send checks passed against the published Google emulator`,
);
