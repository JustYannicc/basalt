export interface RouterEnv {
  TOOLS_SERVICE: {
    fetch(request: Request): Promise<Response>;
  };
}

function isPoolPath(pathname: string): boolean {
  return pathname === "/v1" || pathname.startsWith("/v1/");
}

export function handleRequest(request: Request, env: RouterEnv): Promise<Response> {
  if (isPoolPath(new URL(request.url).pathname)) {
    return Promise.resolve(
      new Response(null, {
        status: 503,
        headers: { "Cache-Control": "no-store" },
      }),
    );
  }

  return env.TOOLS_SERVICE.fetch(request);
}

export default { fetch: handleRequest };
