export async function openPoolOperations({ accountId, worker }) {
  if (accountId !== "local-controller-test" || !/^local-controller-[0-9]+$/.test(worker))
    throw new Error("Local controller destination refused");
  const port = Number(worker.slice("local-controller-".length));
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535)
    throw new Error("Local controller port refused");
  return {
    service: {
      fetch: (request) => {
        const destination = new URL(request.url);
        destination.protocol = "http:";
        destination.hostname = "127.0.0.1";
        destination.port = String(port);
        return fetch(new Request(destination, request));
      },
    },
    close: async () => {},
  };
}
