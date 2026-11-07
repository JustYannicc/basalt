import {readFileSync} from "node:fs";
// Generated from the same current official document used by the scope table. These real routes
// let the installed-app proof resolve every pre-change tool name without contacting PlanetScale.
export const operations = JSON.parse(
  readFileSync(new URL("./legacy-operations.json", import.meta.url), "utf8"),
);

export const planetScaleDocument = (origin) => ({
    openapi: "3.0.1",
    info: { title: "PlanetScale fixture", version: "v1" },
    servers: [{ url: `${origin}/v1` }],
    security: [{ oauth2: [] }],
    components: {
      securitySchemes: {
        oauth2: {
          type: "oauth2",
          flows: {
            authorizationCode: {
              authorizationUrl: `${origin}/oauth/authorize`,
              tokenUrl: `${origin}/oauth/token`,
              scopes: {},
            },
          },
        },
      },
    },
    paths: operations.reduce((paths, { operationId, namespace, method, path }) => {
      const parameters = [...path.matchAll(/\{([^}]+)\}/g)].map(([, name]) => ({
        name,
        in: "path",
        required: true,
        schema: { type: "string" },
      }));
      paths[path] = {
        ...paths[path],
        [method]: {
          operationId,
          tags: [namespace],
          parameters,
          responses: {
            200: {
              description: "OK",
              content: { "application/json": { schema: { type: "object" } } },
            },
          },
        },
      };
      return paths;
    }, {}),
  });
