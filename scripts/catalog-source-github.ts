import { createHash } from "node:crypto";

export type SourceFile = { path: string; content: string };

export type GitHubSourceReader = {
  get<T>(path: string): Promise<T>;
};

type CommitResponse = {
  sha?: string;
  commit?: { tree?: { sha?: string } };
};

type TreeEntry = { path?: string; mode?: string; sha?: string; type?: string };
type TreeResponse = { sha?: string; truncated?: boolean; tree?: TreeEntry[] };
type BlobResponse = { sha?: string; size?: number; encoding?: string; content?: string };

export async function readGitSource(
  repository: string,
  commitSha: string,
  paths: string[],
  github: GitHubSourceReader,
): Promise<SourceFile[]> {
  const commit = await github.get<CommitResponse>(`repos/${repository}/commits/${commitSha}`);
  if (commit.sha !== commitSha || !isGitSha(commit.sha))
    throw new Error(`${repository} source commit response did not match its pinned SHA`);
  const treeSha = commit.commit?.tree?.sha;
  if (!isGitSha(treeSha)) throw new Error(`${repository} pinned commit has no valid root tree SHA`);

  const tree = await github.get<TreeResponse>(
    `repos/${repository}/git/trees/${treeSha}?recursive=1`,
  );
  if (tree.sha !== treeSha || tree.truncated !== false || !Array.isArray(tree.tree))
    throw new Error(`${repository} source tree is missing, mismatched, or truncated`);

  const entries = new Map<string, TreeEntry>();
  for (const entry of tree.tree) {
    if (typeof entry.path === "string") entries.set(entry.path, entry);
  }

  const files = await Promise.all(
    paths.map(async (path): Promise<SourceFile> => {
      const entry = entries.get(path);
      if (!entry)
        throw new Error(`${repository} pinned source is missing allowlisted file ${path}`);
      if (
        entry.type !== "blob" ||
        (entry.mode !== "100644" && entry.mode !== "100755") ||
        !isGitSha(entry.sha)
      )
        throw new Error(`${repository} allowlisted file ${path} is not an ordinary Git blob`);
      const blob = await github.get<BlobResponse>(`repos/${repository}/git/blobs/${entry.sha}`);
      const bytes = decodeBlob(repository, path, entry.sha, blob);
      let content: string;
      try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new Error(`${repository} allowlisted file ${path} is not valid UTF-8 text`);
      }
      return { path, content };
    }),
  );

  return files;
}

function decodeBlob(
  packageName: string,
  path: string,
  expectedSha: string,
  blob: BlobResponse,
): Buffer {
  if (blob.sha !== expectedSha || blob.encoding !== "base64" || typeof blob.content !== "string")
    throw new Error(`${packageName} source blob identity or encoding mismatch for ${path}`);
  const encoded = blob.content.replace(/\s/g, "");
  if (
    encoded !== "" &&
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)
  )
    throw new Error(`${packageName} source blob has invalid base64 for ${path}`);
  const bytes = Buffer.from(encoded, "base64");
  if (
    bytes.toString("base64") !== encoded ||
    blob.size !== bytes.length ||
    gitBlobSha(bytes) !== expectedSha
  )
    throw new Error(`${packageName} source blob integrity mismatch for ${path}`);
  return bytes;
}

function gitBlobSha(bytes: Buffer): string {
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

function isGitSha(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
}
