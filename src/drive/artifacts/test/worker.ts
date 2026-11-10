import { createGitRemote } from "../transport.ts";
import {
  writtenObject,
  encodeTree,
  encodeCommit,
} from "../../shared/.generated/strata/git/write.js";

export default {
  async fetch(request: Request) {
    const input = (await request.json()) as { url: string; token: string; want: string };
    const remote = createGitRemote({ url: input.url, auth: async () => input.token });
    const objects = await remote.fetchObjects({ wants: [input.want] });
    const blob = await writtenObject("blob", new TextEncoder().encode("written inside a Worker"));
    const tree = await writtenObject(
      "tree",
      encodeTree([{ name: "worker.md", kind: "file", mode: "100644", oid: blob.oid }]),
    );
    const commit = await writtenObject(
      "commit",
      encodeCommit({
        tree: tree.oid,
        parents: [input.want],
        message: "Worker push",
        author: { name: "Fixture", email: "fixture@example.invalid", time: 1800000000 },
      }),
    );
    const result = await remote.push({
      updates: [
        {
          ref: "refs/heads/worker",
          old: null,
          next: commit.oid,
        },
      ],
      objects: [blob, tree, commit],
    });
    return Response.json({
      result,
      commit: commit.oid,
      objects: objects.map((object) => ({ ...object, content: Array.from(object.content) })),
    });
  },
};
