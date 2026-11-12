import { createServer, request } from "node:http";
import { connect } from "node:net";
for (const port of [8080, 8317, 8318, 8327]) {
  const host = port === 8080 ? "density-upstream" : "density-pool";
  const server = createServer((incoming, outgoing) => {
    const remote = request(
      { host, port, path: incoming.url, method: incoming.method, headers: incoming.headers },
      (response) => {
        outgoing.writeHead(response.statusCode, response.headers);
        response.pipe(outgoing);
      },
    );
    remote.on("error", () => {
      if (!outgoing.headersSent) outgoing.writeHead(503);
      outgoing.end();
    });
    incoming.on("aborted", () => remote.destroy());
    outgoing.on("close", () => remote.destroy());
    incoming.pipe(remote);
  });
  server.on("upgrade", (req, socket, head) => {
    const remote = connect(port, host, () => {
      remote.write(
        req.method +
          " " +
          req.url +
          " HTTP/1.1\r\n" +
          Object.entries(req.headers)
            .map(([k, v]) => k + ": " + v)
            .join("\r\n") +
          "\r\n\r\n",
      );
      if (head.length) remote.write(head);
      socket.pipe(remote);
      remote.pipe(socket);
    });
    remote.on("error", () => socket.destroy());
    socket.on("error", () => remote.destroy());
    socket.on("close", () => remote.destroy());
  });
  server.listen(port, "0.0.0.0");
}
