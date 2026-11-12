import { performance } from "node:perf_hooks";
export async function operation(origin, protocol, id, durationMs, contentBytes, rate) {
  const begin = performance.now(),
    at = Date.now();
  let status = 0,
    firstByte = null,
    textBytes = 0,
    wireBytes = 0,
    terminal = false,
    deltas = 0,
    maxGap = 0,
    lastDelta = null,
    protocolError = null;
  const consume = (x) => {
    if (x.type === "content_block_delta" && typeof x.delta?.text === "string") {
      textBytes += Buffer.byteLength(x.delta.text);
      deltas++;
    }
    if (x.type === "response.output_text.delta" && typeof x.delta === "string") {
      textBytes += Buffer.byteLength(x.delta);
      deltas++;
    }
    if (x.type === "message_stop" || x.type === "response.completed") terminal = true;
    if (x.type === "error" || x.type === "response.failed") {
      protocolError = x;
      throw Error("Protocol failure");
    }
    if (x.type === "content_block_delta" || x.type === "response.output_text.delta") {
      const now = performance.now();
      if (lastDelta !== null) maxGap = Math.max(maxGap, now - lastDelta);
      lastDelta = now;
    }
  };
  try {
    if (protocol === "websocket") {
      await new Promise((resolve, reject) => {
        const ws = new WebSocket(origin.replace(/^http/, "ws") + "/v1/responses", {
          headers: { Authorization: "Bearer synthetic-density-model" },
        });
        const timer = setTimeout(() => {
          ws.close();
          reject(Error("WebSocket operation timeout"));
        }, durationMs + 45000);
        const finish = (error) => {
          clearTimeout(timer);
          ws.close();
          if (error) reject(error);
          else resolve();
        };
        ws.addEventListener("open", () => {
          status = 101;
          ws.send(
            JSON.stringify({
              type: "response.create",
              model: "density-synthetic",
              input: [{ role: "user", content: [{ type: "input_text", text: id }] }],
            }),
          );
        });
        ws.addEventListener("message", (e) => {
          try {
            firstByte ??= performance.now() - begin;
            wireBytes += Buffer.byteLength(String(e.data));
            consume(JSON.parse(String(e.data)));
            if (terminal) finish();
          } catch (error) {
            finish(error);
          }
        });
        ws.addEventListener("error", () => finish(Error("WebSocket transport error")));
        ws.addEventListener("close", () => {
          if (!terminal) finish(Error("WebSocket closed before terminal"));
        });
      });
    } else {
      const messages = protocol === "messages",
        body = messages
          ? {
              model: "density-synthetic",
              max_tokens: 4096,
              stream: true,
              messages: [{ role: "user", content: id }],
            }
          : { model: "density-synthetic", stream: true, input: id };
      const response = await fetch(origin + (messages ? "/v1/messages" : "/v1/responses"), {
        method: "POST",
        headers: {
          authorization: "Bearer synthetic-density-model",
          "x-api-key": "synthetic-density-model",
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(durationMs + 45000),
      });
      status = response.status;
      let pending = "";
      for await (const chunk of response.body) {
        firstByte ??= performance.now() - begin;
        wireBytes += chunk.length;
        pending += Buffer.from(chunk).toString();
        let split;
        while ((split = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, split).trimEnd();
          pending = pending.slice(split + 1);
          if (line.startsWith("data: ")) {
            const data = line.slice(6);
            if (data !== "[DONE]") consume(JSON.parse(data));
          }
        }
      }
    }
    return {
      id,
      protocol,
      at,
      endedAt: Date.now(),
      status,
      firstByteMs: firstByte,
      elapsedMs: performance.now() - begin,
      textBytes,
      wireBytes,
      terminal,
      deltas,
      maxDeltaGapMs: maxGap,
      expectedTextBytes: ((durationMs * rate) / 1000) * contentBytes,
      pass:
        (protocol === "websocket" ? status === 101 : status === 200) &&
        terminal &&
        textBytes === ((durationMs * rate) / 1000) * contentBytes,
    };
  } catch (error) {
    return {
      id,
      protocol,
      at,
      endedAt: Date.now(),
      status,
      firstByteMs: firstByte,
      elapsedMs: performance.now() - begin,
      textBytes,
      wireBytes,
      terminal,
      deltas,
      error: { name: error.name, message: error.message, protocol: protocolError },
      pass: false,
    };
  }
}
