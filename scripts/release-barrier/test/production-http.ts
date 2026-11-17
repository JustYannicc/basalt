import { Effect } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpResponse from "effect/http/HttpClientResponse";

type Handler = Parameters<typeof HttpClient.make>[0];
type Reply = Effect.Effect<
  HttpResponse.HttpClientResponse | Response,
  HttpClientError.HttpClientError
>;

const nativeInit = (request: HttpClientRequest.HttpClientRequest): RequestInit => {
  const body = request.body;
  switch (body._tag) {
    case "Empty":
      return { method: request.method };
    case "Raw":
    case "Uint8Array":
      return { method: request.method, body: body.body as BodyInit };
    case "FormData":
      return { method: request.method, body: body.formData };
    case "Stream":
      return {
        method: request.method,
        body: new ReadableStream(),
        duplex: "half",
      } as RequestInit;
  }
};

const refusedBody = (response: Response) =>
  response.status >= 200 && response.status < 300 ? undefined : response.bodyUsed;

/**
 * A fake Effect HttpClient that refuses what native fetch refuses (a GET/HEAD body throws its
 * TypeError, surfaced the way FetchHttpClient surfaces it) and hands back non-2xx bodies unread.
 * Fakes that ignored request bodies let a body-carrying baseline GET reach production.
 */
export const productionHttpClient = (handler: (...args: Parameters<Handler>) => Reply) =>
  HttpClient.make((request, url, signal, fiber) =>
    Effect.suspend(() => {
      try {
        new Request(url, nativeInit(request));
      } catch (cause) {
        return Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({ request, cause }),
          }),
        );
      }
      return handler(request, url, signal, fiber).pipe(
        Effect.map((reply) => {
          if (!(reply instanceof Response)) return reply;
          if (refusedBody(reply))
            throw new Error(`fake ${reply.status} reply consumed its body before the client`);
          return HttpResponse.fromWeb(request, reply);
        }),
      );
    }),
  );

/** The same contract for injected `fetch` stubs: `new Request` throws the native TypeError. */
export const productionFetch =
  (handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) =>
  async (input: RequestInfo | URL, init?: RequestInit) => {
    new Request(input, init);
    const reply = await handler(input, init);
    if (refusedBody(reply))
      throw new Error(`fake ${reply.status} reply consumed its body before the client`);
    return reply;
  };
