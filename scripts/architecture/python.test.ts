import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { pythonDependencies } from "./python.ts";
import type { Module, OutsideService } from "./source.ts";

const temporary: string[] = [];
afterEach(() => temporary.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })));
function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "architecture-python-"));
  temporary.push(root);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(join(root, file, ".."), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  return root;
}
const module = (id: string, code: string, libraries: string[] = []): Module => ({ id, code, bindings: [], libraries });
const api: OutsideService = { id: "api", hosts: ["api.example.invalid", "*.service.example.invalid"], sdks: ["example_sdk"] };
function scan(text: string, services: OutsideService[] = [], libraries: string[] = []) {
  return pythonDependencies(fixture({ "src/app.py": text }), [module("app", "src/app.py", libraries)], services);
}

test("all runtime literals and third-party imports need outside-service or library coverage", () => {
  const result = scan('import unknown_sdk\ndef unused():\n    return "https://unknown.example.invalid/v1"\n');
  expect(result.errors.join("\n")).toContain("Unmodelled SDK or library: unknown_sdk");
  expect(result.errors.join("\n")).toContain("Unmodelled outside host: unknown.example.invalid");
  expect(scan("import pure_library\nimport json\n", [], ["pure_library"]).errors).toEqual([]);
});

test("modelled SDKs and URLs produce caller dependencies, including wildcard hosts", () => {
  const result = scan('from example_sdk.client import Client\nURL = "https://api.example.invalid/v1"\nOTHER = "https://a.service.example.invalid/v1"\n', [api]);
  expect(result.errors).toEqual([]);
  expect(result.dependencies).toEqual(expect.arrayContaining([
    expect.objectContaining({ source: "app", target: "api", evidence: expect.stringContaining("example_sdk.client.Client") }),
    expect.objectContaining({ source: "app", target: "api", evidence: expect.stringContaining("api.example.invalid") }),
    expect.objectContaining({ source: "app", target: "api", evidence: expect.stringContaining("a.service.example.invalid") }),
  ]));
});

test.each([
  'import urllib.request as u\nu.urlopen("https://new.example.invalid")',
  'from urllib import request as u\nsend = u.urlopen\nsend("https://new.example.invalid")',
  'from urllib.request import urlopen as send, Request as Req\nr = Req("https://new.example.invalid")\nsend(r)',
])("urllib aliases retain their actual destination", text => {
  expect(scan(text).errors.join("\n")).toContain("Unmodelled outside host: new.example.invalid");
});

test.each([
  'import os, urllib.request\nurllib.request.urlopen(os.getenv("OUTSIDE"))',
  'from urllib.request import urlopen\nHOST = "http://127.0.0.1"\nurlopen(compute_url())',
  'from urllib.request import urlopen\nimport os\nurlopen(f"https://{os.getenv(\'HOST\')}/v1")',
  'from urllib.request import urlopen\ndef send(url):\n    urlopen(url)\nsend(compute_url())',
  'import urllib.request as u\nu.urlopen("http://127.0.0.1" if choose else compute_url())',
])("unknown computed URLs fail closed", text => {
  expect(scan(text).errors.join("\n")).toContain("dynamic or unsupported host");
});

test("constant hosts with computed paths and direct helper callsites resolve", () => {
  const result = scan(`from urllib.request import Request as Req, urlopen as send
HOME_URL = "http://127.0.0.1:8327"
NODE_URL = "http://[::1]:8317"
def request_json(url, method="GET"):
    request = Req(url, method=method)
    return send(request)
def health(node):
    request_json(f"{HOME_URL}/health/{node}")
    request_json(url=f"{NODE_URL}/healthz", method="GET")
request_json("http://localhost:8318/ready")
`);
  expect(result.errors).toEqual([]);
  expect(result.dependencies).toEqual([]);
});

test("one dynamic helper call cannot hide among resolved loopback calls", () => {
  const result = scan('from urllib.request import urlopen\ndef send(url):\n    urlopen(url)\nsend("http://127.0.0.1/ready")\nsend(unknown())\n');
  expect(result.errors.join("\n")).toContain("dynamic or unsupported host");
});

test("absolute and relative own imports produce module edges", () => {
  const root = fixture({ "src/a.py": "import b\nfrom .b import VALUE\n", "src/b.py": "VALUE = 1\n" });
  const result = pythonDependencies(root, [module("a", "src/a.py"), module("b", "src/b.py")], []);
  expect(result.errors).toEqual([]);
  expect(result.dependencies.map(edge => `${edge.source}->${edge.target}`)).toEqual(["a->b", "a->b"]);
});

test("imported own helper arguments are checked at all callers", () => {
  const root = fixture({
    "src/a.py": 'from b import send\nsend("http://127.0.0.1/ready")\nsend(compute_url())\n',
    "src/b.py": "from urllib.request import urlopen\ndef send(destination):\n    return urlopen(destination)\n",
  });
  const result = pythonDependencies(root, [module("a", "src/a.py"), module("b", "src/b.py")], []);
  expect(result.errors.join("\n")).toContain("dynamic or unsupported host");
  expect(result.dependencies).toEqual(expect.arrayContaining([expect.objectContaining({ source: "a", target: "b" })]));
});

test("builder Python and tests are excluded by ownership, final-stage Python is scanned", () => {
  const root = fixture({
    "containers/pool/Dockerfile": "FROM python:3 AS builder\nCOPY fetch.py ./\nFROM python:3\nCOPY run.py tests /app/\n",
    "containers/pool/fetch.py": 'import unknown_build_sdk\nURL = "https://build.example.invalid"',
    "containers/pool/run.py": 'URL = "https://runtime.example.invalid"',
    "containers/pool/tests/test_runtime.py": 'import unknown_test_sdk',
    "src/test_runtime.py": "import unknown_test_sdk",
  });
  const result = pythonDependencies(root, [module("pool", "containers/pool"), module("tests", "src")], []);
  expect(result.errors).toEqual(["containers/pool/run.py:1: Unmodelled outside host: runtime.example.invalid"]);
});

test("the actual final-stage pool wrapper passes without importing or executing inspected source", () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const files = Object.fromEntries(["Dockerfile", "releases.json", "fetch_releases.py", "supervisor.py", "pool_contract.py", "readiness.py", "healthcheck.py", "__init__.py"].map(file =>
    [`containers/pool/${file}`, readFileSync(join(root, "containers/pool", file), "utf8")]));
  const copy = fixture(files);
  expect(pythonDependencies(copy, [module("pool", "containers/pool")], [])).toEqual({ dependencies: [], errors: [] });
});

test.each([
  "from http import client\nclient.HTTPSConnection(unknown_host)",
  "import socket\nsocket.create_connection((unknown_host, 443))",
  "import urllib.request as u\nu.build_opener().open(compute_url())",
  'import urllib.request as u\ngetattr(u, "urlopen")(compute_url())',
  "from urllib.request import urlopen\nsubmit(urlopen, compute_url())",
  'import importlib\nimportlib.import_module("unknown_sdk")',
  'from urllib.request import Request, urlopen\nr = Request("http://127.0.0.1")\nr.full_url = compute_url()\nurlopen(r)',
  'from urllib.request import urlopen\ndef send(url):\n    urlopen(url)\nsend("http://127.0.0.1")\nqueue = [send]\nqueue[0](compute_url())',
  "import http\nhttp.client.HTTPSConnection(unknown_host)",
])("unsupported Python networking and execution constructs are explicit", text => {
  expect(scan(text).errors.length).toBeGreaterThan(0);
});

test("invalid Python is a reported parse failure, and unowned Python is rejected", () => {
  expect(scan("def broken(:").errors.join("\n")).toContain("invalid syntax");
  const root = fixture({ "src/unowned.py": "pass" });
  expect(pythonDependencies(root, [], []).errors).toEqual(["Unmodelled Python code: src/unowned.py"]);
});
