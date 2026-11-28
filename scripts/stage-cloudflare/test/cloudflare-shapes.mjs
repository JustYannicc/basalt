// The Cloudflare and registry answers the stage tools read, in one place. Worker script, Worker
// settings and container application bodies are the production read-backs recorded on 2026-11-18
// (scripts/pool-fleet/test/cloudflare-shapes.ts); the rest follow the API schema the pinned
// @distilled.cloud/cloudflare SDK is generated from, or the OCI distribution spec for the registry.
// Builders fill in only the fields a test is about.
import {
  envelope,
  resolvedApplication,
  scriptListItem,
  workerSettings,
} from "../../pool-fleet/test/cloudflare-shapes.ts";

export { envelope };

/** A page of a v4 listing: the envelope with `result_info` (count, page, per_page, total_*). */
export const listPage = (result, { page = 1, totalPages = 1 } = {}) => ({
  ...envelope(result),
  result_info: {
    page,
    per_page: 100,
    count: result.length,
    total_count: totalPages * 100,
    total_pages: totalPages,
  },
});

/** A v4 refusal: HTTP 4xx or 5xx, or 200 with `success: false`. */
export const refusalBody = (errors) => ({ success: false, errors, messages: [], result: null });

/** GET containers/applications list item: the same object as the recorded read of one. */
export const application = ({ id, name, image = resolvedApplication.configuration.image }) => ({
  ...resolvedApplication,
  id,
  name,
  configuration: { ...resolvedApplication.configuration, image },
});

/** GET workers/scripts list item. */
export const script = (id) => ({ ...scriptListItem, id });

/** GET workers/durable_objects/namespaces list item (NamespacesListResultItem). */
export const namespace = ({ id, className, script: owner, name = `${owner}_${className}` }) => ({
  id,
  name,
  script: owner,
  class: className,
  use_sqlite: true,
});

/** GET hyperdrive/configs list item, public database origin (ConfigsListResultItem). */
export const hyperdrive = ({ id, name }) => ({
  id,
  name,
  origin: { database: "<name>", host: "<host>", port: 5432, scheme: "postgres", user: "<name>" },
  caching: { disabled: false },
  created_on: "2026-11-18T18:30:00Z",
  modified_on: "2026-11-18T18:30:00Z",
});

/** GET mtls_certificates list item (ListResultItem). */
export const certificate = ({ id, name }) => ({
  id,
  name,
  ca: true,
  certificates: "<pem>",
  expires_on: "2027-11-18T18:30:00Z",
  issuer: "<issuer>",
  serial_number: "<serial>",
  signature: "SHA256WithRSA",
  uploaded_on: "2026-11-18T18:30:00Z",
});

/** GET workers/scripts/{name}/settings, with one plain-text binding per entry of `text`. */
export const settings = (text = {}) =>
  envelope({
    ...workerSettings,
    bindings: [
      ...workerSettings.bindings,
      ...Object.entries(text).map(([name, value]) => ({ name, text: value, type: "plain_text" })),
    ],
  });

/** GET workers/subdomain (GetSubdomainResponse). */
export const subdomain = (name) => envelope({ subdomain: name });

/**
 * POST containers/registries/{host}/credentials. The endpoint is absent from Cloudflare's public
 * docs; the SDK transcribes `user` or `username` beside `password`, and no response is recorded yet.
 */
export const registryCredentials = () => envelope({ username: "<name>", password: "<secret>" });

/** GET /v2/_catalog (OCI distribution). */
export const catalog = (repositories) => ({ repositories });
/** GET /v2/{name}/tags/list (OCI distribution); a repository whose tags are deleted has `null`. */
export const tagList = (name, tags) => ({ name, tags });
/** GET /v2/{name}/manifests/{reference} for an image index. */
export const imageIndex = (digests) => ({
  schemaVersion: 2,
  mediaType: "application/vnd.oci.image.index.v1+json",
  manifests: digests.map((digest) => ({
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    digest,
    size: 1024,
    platform: { architecture: "amd64", os: "linux" },
  })),
});
