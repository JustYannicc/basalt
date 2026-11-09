import assert from "node:assert/strict";
import { test } from "node:test";
import type { Feed, FeedEntry, FeedSource } from "./feed.ts";
import { clerkSource, withClerkSignIn } from "./clerk.ts";
import { elevenlabsSource, withElevenLabsSignIn } from "./elevenlabs.ts";
import { gitlabSource, withGitLabInstances } from "./gitlab.ts";
import { vercelSource, withVercelSignIn } from "./vercel.ts";
import { workosSource, withWorkOSSignIn } from "./workos.ts";

/** The account requirement names an app source declares in `defineApp`. */
const declaredRequirements = (source: FeedSource) => {
  const code = source.files
    .map((file) => file as { path?: string; content?: string })
    .filter((file) => file.path?.endsWith(".ts"))
    .map((file) => file.content ?? "")
    .join("\n");
  const block = /accounts:\s*\{([^}]*)\}/.exec(code)?.[1] ?? "";
  return [...block.matchAll(/(\w+):\s*\w+\.many\(\)/g)].map((match) => match[1]);
};

const entry = (id: string, source: FeedSource): FeedEntry => ({
  id,
  package: source.package,
  name: id,
  description: "",
  auth: [],
  icons: [],
  source: `apps/${id}.json`,
});

const services = [
  { id: "clerk", source: clerkSource, apply: withClerkSignIn },
  { id: "workos", source: workosSource, apply: withWorkOSSignIn },
  { id: "elevenlabs", source: elevenlabsSource, apply: withElevenLabsSignIn },
  { id: "gitlab", source: gitlabSource, apply: withGitLabInstances },
  { id: "vercel", source: vercelSource, apply: withVercelSignIn },
] as const;

test("each requirement's tools are named for exactly the requirements the app declares", () => {
  for (const { id, source, apply } of services) {
    const feed: Feed = { version: 1, apps: [entry(id, source)] };
    const tools = apply(feed).apps[0]!.requirementTools;
    assert.ok(tools, `${id} names its requirements' tools`);
    assert.deepEqual(
      Object.keys(tools).sort(),
      declaredRequirements(source).sort(),
      `${id} names the tools of every requirement it declares, and no other`,
    );
    // Rows say what they can't run by the other requirement's tools, so the names must differ.
    assert.equal(new Set(Object.values(tools)).size, Object.keys(tools).length, id);
  }
});
