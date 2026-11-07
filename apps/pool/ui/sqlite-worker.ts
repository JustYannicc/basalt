// An HTML build entry gives the host compiler a retained worker URL and all of its chunks.
// Queue the first message while the worker's SQLite module loads; the page does nothing.
if (typeof document === "undefined") {
  const runtime = import("./sqlite-worker-runtime.ts");
  self.onmessage = (event: MessageEvent<{ file?: File }>) => {
    void runtime
      .then((module) => module.readMessage(event))
      .catch(() => {
        self.postMessage({
          error: "Couldn't load the SQLite reader. Reload this page and try again.",
        });
      });
  };
}
