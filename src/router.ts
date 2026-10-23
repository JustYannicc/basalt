interface Service {
  fetch(request: Request): Promise<Response>;
}

export interface RouterEnv {
  TOOLS_SERVICE: Service;
  POOL_SERVICE: Service;
}

function isPoolPath(pathname: string): boolean {
  return pathname === "/v1" || pathname.startsWith("/v1/");
}

function isPoolManagementPath(pathname: string): boolean {
  return /^\/v(?:0|8)\/management(?:\/|$)/.test(pathname);
}

export function handleRequest(request: Request, env: RouterEnv): Promise<Response> {
  const pathname = new URL(request.url).pathname;
  if (isPoolPath(pathname) || isPoolManagementPath(pathname)) {
    return env.POOL_SERVICE.fetch(request);
  }

  return env.TOOLS_SERVICE.fetch(request);
}

export default { fetch: handleRequest };
