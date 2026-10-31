/** Stateful loopback API responses for the real generated Atlassian operations. */
export function atlassianApiFixture() {
  const issues = new Map();
  const pages = new Map();
  const writes = [];
  return {
    writes,
    async handle({ request, url, response, person, log, body, json }) {
      const site = /^\/ex\/(jira|confluence)\/([^/]+)(\/.*)$/.exec(url.pathname);
      if (!site) return false;
      log.person = person.key;
      const reply = (status, value) => {
        log.status = status;
        json(response, status, value);
        return true;
      };
      if (decodeURIComponent(site[2]) !== person.cloudId)
        return reply(403, { message: "site belongs to another account" });
      const path = site[3];
      const method = request.method;
      const issue = `/rest/api/3/issue/${person.issueKey}`;
      const pageId = person.key === "first" ? "9101" : "9202";
      const page = `/wiki/api/v2/pages/${pageId}`;
      const record = (payload) =>
        writes.push({ person: person.key, path: url.pathname, method, payload });
      if (path === "/rest/api/3/issue" && method === "POST") {
        const payload = JSON.parse(await body(request));
        if (payload.fields?.summary !== person.jiraMarker)
          return reply(400, { errorMessages: ["wrong caller marker"] });
        issues.set(person.key, payload.fields);
        record(payload);
        return reply(201, { id: pageId, key: person.issueKey, self: `${url.origin}${issue}` });
      }
      if (path === issue && ["PUT", "DELETE"].includes(method)) {
        if (!issues.has(person.key)) return reply(404, { errorMessages: ["issue not found"] });
        const payload = method === "PUT" ? JSON.parse(await body(request)) : undefined;
        if (method === "PUT")
          issues.set(person.key, { ...issues.get(person.key), ...payload.fields });
        else issues.delete(person.key);
        record(payload);
        log.status = 204;
        response.writeHead(204);
        response.end();
        return true;
      }
      if (path === "/rest/servicedeskapi/request" && method === "POST") {
        const payload = JSON.parse(await body(request));
        if (payload.requestFieldValues?.summary !== person.jiraMarker)
          return reply(400, { message: "wrong caller marker" });
        record(payload);
        return reply(201, {
          issueId: pageId,
          issueKey: person.issueKey,
          summary: person.jiraMarker,
          serviceDeskId: payload.serviceDeskId,
          requestTypeId: payload.requestTypeId,
        });
      }
      if (path === "/rest/servicedeskapi/servicedesk/10/requesttype" && method === "POST") {
        if (request.headers["x-experimentalapi"] !== "opt-in")
          return reply(400, { message: "missing experimental opt-in" });
        const payload = JSON.parse(await body(request));
        record(payload);
        return reply(200, {
          id: "25",
          name: payload.name,
          issueTypeId: payload.issueTypeId,
          serviceDeskId: "10",
        });
      }
      if (
        path === `/rest/servicedeskapi/request/${person.issueKey}/comment/1/attachment` &&
        method === "GET"
      ) {
        if (request.headers["x-experimentalapi"] !== "opt-in")
          return reply(400, { message: "missing experimental opt-in" });
        return reply(200, { values: [], start: 0, limit: 50, size: 0, isLastPage: true });
      }
      if (path === "/wiki/rest/api/space" && method === "POST") {
        const payload = JSON.parse(await body(request));
        record(payload);
        return reply(200, {
          id: Number(pageId),
          key: payload.key,
          name: payload.name,
          status: "current",
          type: "global",
          _expandable: {},
          _links: {},
        });
      }
      if (path === "/wiki/api/v2/pages" && method === "POST") {
        const payload = JSON.parse(await body(request));
        if (payload.title !== person.pageMarker)
          return reply(400, { message: "wrong caller marker" });
        const value = {
          id: pageId,
          title: payload.title,
          spaceId: payload.spaceId,
          status: "current",
          body: { storage: payload.body.storage ?? payload.body },
          version: { number: 1 },
        };
        pages.set(person.key, value);
        record(payload);
        return reply(200, value);
      }
      if (path === page && ["GET", "PUT", "DELETE"].includes(method)) {
        if (!pages.has(person.key)) return reply(404, { message: "page not found" });
        if (method === "GET") return reply(200, pages.get(person.key));
        const payload = method === "PUT" ? JSON.parse(await body(request)) : undefined;
        if (method === "PUT")
          pages.set(person.key, {
            ...pages.get(person.key),
            title: payload.title,
            version: payload.version,
            body: { storage: payload.body.storage ?? payload.body },
          });
        else pages.delete(person.key);
        record(payload);
        if (method === "PUT") return reply(200, pages.get(person.key));
        log.status = 204;
        response.writeHead(204);
        response.end();
        return true;
      }
      const watch = /^\/wiki\/rest\/api\/user\/watch\/content\/\d+$/.test(path);
      if (watch && method === "POST") {
        if (request.headers["x-atlassian-token"] !== "no-check")
          return reply(400, { message: "missing XSRF opt-out" });
        record(undefined);
        log.status = 204;
        response.writeHead(204);
        response.end();
        return true;
      }
      return false;
    },
  };
}
