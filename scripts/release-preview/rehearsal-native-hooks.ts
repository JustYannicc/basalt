import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { planStageVariant, redeployStage } from "../preview/lifecycle.ts";
import { stageNames, type StageSubject } from "../preview/subject.ts";
import { shapeOf } from "../release-barrier/rehearsal-shape-capture.ts";
import type { NativeHooks, NativeReadBack } from "./rehearsal-native.ts";
import { redactor } from "./redact.ts";

/** PoolWorker without its fleet declaration: production's shape before the cutover. */
export const withoutFleetDeclaration = {
  path: "src/pool/deployment.ts",
  from: "...fleetBindings(fleet),",
  to: "...fleet,",
} as const;

type Context = {
  root: string;
  previousRoot: string;
  subject: StageSubject;
  deployEnvironment: NodeJS.ProcessEnv;
  deployBaseline(): Promise<void>;
  build(): Promise<void>;
  serve(): Promise<unknown>;
  fetcher?: typeof fetch;
};

/**
 * A managed-registry image reference, by tag or by digest. A digest reference is pinned as it is;
 * a tag is resolved to its digest through the registry first.
 */
export function managedReference(
  reference: string,
): { kind: "digest"; reference: string } | { kind: "tag"; repository: string; tag: string } {
  if (/^registry\.cloudflare\.com\/[a-z0-9][a-z0-9/_.-]*@sha256:[a-f0-9]{64}$/u.test(reference))
    return { kind: "digest", reference };
  const [, repository, tag] =
    /^registry\.cloudflare\.com\/([^@]+):([^:/@]+)$/u.exec(reference) ?? [];
  if (!repository || !tag)
    throw new Error("The stage pool image is not a managed-registry reference by tag or digest");
  return { kind: "tag", repository, tag };
}

export function nativeHooks(context: Context): NativeHooks {
  const { root, previousRoot, subject, deployEnvironment } = context;
  const fetcher = context.fetcher ?? fetch;
  const accountId = deployEnvironment.CLOUDFLARE_ACCOUNT_ID ?? "";
  const token = deployEnvironment.CLOUDFLARE_API_TOKEN ?? "";
  const { stage } = stageNames(subject);
  const redact = redactor(deployEnvironment, process.env);
  const receipts = join(root, ".local", "release-barrier");
  const keep = async (name: string, value: unknown) => {
    await mkdir(receipts, { recursive: true });
    await writeFile(join(receipts, name), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  };
  const cf = async (path: string) => {
    const response = await fetcher(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}${path}`,
      {
        headers: { Authorization: `Bearer ${token}` },
      },
    );
    const body = (await response.json()) as { success?: boolean; result?: unknown };
    if (!response.ok || body.success === false)
      throw new Error(`Cloudflare read ${path.split("?")[0]} failed with HTTP ${response.status}`);
    return body.result;
  };
  const poolWorker = async () => {
    const scripts = (await cf("/workers/scripts")) as { id: string; tags?: string[] }[];
    const found = scripts.filter(
      (script) =>
        script.tags?.includes(`alchemy:stage:${stage}`) &&
        script.tags.includes("alchemy:id:PoolWorker"),
    );
    if (found.length !== 1) throw new Error(`The stage has ${found.length} PoolWorker scripts`);
    return found[0]!.id;
  };
  const readBack = async (label: string): Promise<NativeReadBack> => {
    const script = await poolWorker();
    const settings = (await cf(`/workers/scripts/${encodeURIComponent(script)}/settings`)) as {
      bindings?: {
        name: string;
        type: string;
        class_name?: string;
        script_name?: string;
        text?: string;
      }[];
    };
    const namespaces: { id: string; class: string; script?: string }[] = [];
    for (let page = 1; page < 20; page += 1) {
      const result = (await cf(
        `/workers/durable_objects/namespaces?page=${page}&per_page=1000`,
      )) as typeof namespaces;
      namespaces.push(...result);
      if (result.length < 1000) break;
    }
    const own = namespaces.filter((namespace) => namespace.script === script);
    const applications = (await cf("/containers/applications")) as {
      id: string;
      name: string;
      configuration?: { image?: string };
      instances?: number;
      durable_objects?: { namespace_id?: string };
    }[];
    const ownApplications = applications.filter((application) =>
      own.some((namespace) => namespace.id === application.durable_objects?.namespace_id),
    );
    const read: NativeReadBack = {
      bindings: (settings.bindings ?? [])
        .filter(
          (binding) => binding.type === "durable_object_namespace" || binding.type === "container",
        )
        .map((binding) => ({
          name: binding.name,
          type: binding.type,
          ...(binding.class_name ? { className: binding.class_name } : {}),
        })),
      namespaces: own.map((namespace) => namespace.class).sort(),
      applications: [],
      // Only the identity bindings a pin or check needs; never secrets.
      plainText: Object.fromEntries(
        (settings.bindings ?? [])
          .filter(
            (binding) =>
              binding.type === "plain_text" &&
              /^POOL_IMAGE_HASH$|_APPLICATION_ID$/u.test(binding.name),
          )
          .map((binding) => [binding.name, binding.text ?? ""]),
      ),
    };
    for (const application of ownApplications) {
      const detail = await cf(`/containers/applications/${application.id}`);
      let instancesShape: unknown;
      try {
        instancesShape = shapeOf(await cf(`/containers/applications/${application.id}/instances`));
      } catch (error) {
        instancesShape = `unreadable: ${error instanceof Error ? error.message : "error"}`;
      }
      read.applications.push({
        name: application.name.replace(stage, "<stage>"),
        className: own.find(
          (namespace) => namespace.id === application.durable_objects?.namespace_id,
        )?.class,
        image: application.configuration?.image?.split("/").slice(2).join("/"),
        instances: application.instances,
        version: (detail as { version?: unknown } | undefined)?.version,
        shape: shapeOf(detail),
        instancesShape,
      });
    }
    await keep(`native-readback-${label}.json`, read);
    console.log(
      redact(
        `native read-back ${label}: ${JSON.stringify({ bindings: read.bindings, namespaces: read.namespaces, applications: read.applications.map(({ name, className, image, instances }) => ({ name, className, image, instances })) })}`,
      ),
    );
    return read;
  };
  const digest = async (reference: string) => {
    const parsed = managedReference(reference);
    // A root pinned by digest (production's image on lane 2) is already immutable.
    if (parsed.kind === "digest") return reference;
    const minted = await fetcher(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/containers/registries/registry.cloudflare.com/credentials`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ permissions: ["pull"], expiration_minutes: 10 }),
      },
    );
    const body = (await minted.json()) as {
      result?: { username?: string; user?: string; password?: string };
    };
    const user = body.result?.username ?? body.result?.user;
    if (!minted.ok || !user || !body.result?.password)
      throw new Error(`Registry credentials refused with HTTP ${minted.status}`);
    const { repository, tag } = parsed;
    const head = await fetcher(
      `https://registry.cloudflare.com/v2/${repository}/manifests/${encodeURIComponent(tag)}`,
      {
        method: "HEAD",
        headers: {
          Authorization: `Basic ${Buffer.from(`${user}:${body.result.password}`).toString("base64")}`,
          Accept:
            "application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json",
        },
      },
    );
    const value = head.headers.get("docker-content-digest");
    if (!head.ok || !value || !/^sha256:[a-f0-9]{64}$/u.test(value))
      throw new Error(`Registry manifest read failed with HTTP ${head.status}`);
    return `registry.cloudflare.com/${repository}@${value}`;
  };
  return {
    deployBaseline: async () => {
      // The baseline checkout is disposable; it deploys as production's PoolWorker is declared today.
      const path = join(previousRoot, withoutFleetDeclaration.path);
      const original = await readFile(path, "utf8");
      if (original.split(withoutFleetDeclaration.from).length !== 2)
        throw new Error("PoolWorker's fleet declaration seam changed");
      await writeFile(
        path,
        original.replace(withoutFleetDeclaration.from, withoutFleetDeclaration.to),
      );
      await context.deployBaseline();
    },
    readBack,
    build: context.build,
    fleetImages: async () => {
      const script = await poolWorker();
      const namespaces = (
        (await cf("/workers/durable_objects/namespaces?page=1&per_page=1000")) as {
          id: string;
          class: string;
          script?: string;
        }[]
      ).filter((namespace) => namespace.script === script && namespace.class === "PoolContainer");
      const applications = (await cf("/containers/applications")) as {
        configuration?: { image?: string };
        durable_objects?: { namespace_id?: string };
      }[];
      const pool = applications.find((application) =>
        namespaces.some((namespace) => namespace.id === application.durable_objects?.namespace_id),
      );
      const image = pool?.configuration?.image;
      if (!image) throw new Error("The stage has no PoolContainer image to pin the fleet to");
      const pinned = await digest(image);
      await keep("native-fleet-images.json", { reference: pinned.split("/").slice(2).join("/") });
      return { blue: pinned, green: pinned };
    },
    plan: async (label, images) => {
      const text = await planStageVariant(root, subject, deployEnvironment, undefined, {
        POOL_FLEET_IMAGES: JSON.stringify(images),
      });
      const safe = redact(text);
      await keep(`native-plan-${label}.json`, { plan: safe.split(/\r?\n/u) });
      console.log(`::group::native plan ${label} (secrets redacted)\n${safe}\n::endgroup::`);
      return safe;
    },
    apply: (images) =>
      redeployStage(root, subject, deployEnvironment, {
        POOL_FLEET_IMAGES: JSON.stringify(images),
      }),
    serve: context.serve,
  };
}
