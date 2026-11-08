process.on("message", async (message) => {
  if (message.kind === "open") process.send({ kind: "ready" });
  if (message.kind === "close") process.send({ kind: "closed" });
  if (message.kind === "request") {
    const url = new URL(message.url);
    const body =
      url.pathname === "/runtime-recovery"
        ? JSON.stringify({ node: !process.versions.bun })
        : Buffer.from(message.body ?? "", "base64").toString();
    process.send({
      kind: "result",
      id: message.id,
      status: url.pathname === "/unready" ? 503 : 200,
      headers: [["content-type", "application/json"]],
      body: Buffer.from(body).toString("base64"),
    });
  }
});
