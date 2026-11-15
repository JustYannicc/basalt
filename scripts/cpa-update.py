"""Prepare a source-built CPA update without changing its existing carries."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
REPOSITORY = "router-for-me/CLIProxyAPI"
MODULE = "github.com/router-for-me/CLIProxyAPI/v8"


def native_module_metadata(root, tag):
    # Resolve public dependencies independently of caller workspace and checksum exemptions.
    environment = {**os.environ, "GOENV": "off", "GOWORK": "off", "GOFLAGS": "",
                   "GO111MODULE": "on", "GOSUMDB": "sum.golang.org",
                   "GONOSUMDB": "", "GOPRIVATE": "", "GOINSECURE": ""}
    environment.pop("GONOSUMCHECK", None)
    with tempfile.TemporaryDirectory(prefix="cpa-native-module-") as temporary:
        module = Path(temporary) / "typesafe"
        shutil.copytree(root / "containers/pool/typesafe", module)
        for command in (["go", "mod", "edit", f"-require={MODULE}@{tag}"], ["go", "mod", "tidy"]):
            subprocess.run(command, cwd=module, env=environment, check=True, text=True)
        return {name: (module / name).read_text() for name in ("go.mod", "go.sum")}


def api(path):
    headers = {"Accept": "application/vnd.github+json"}
    if token := os.environ.get("GH_TOKEN"):
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(f"https://api.github.com/repos/{REPOSITORY}/{path}", headers=headers)
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.load(response)


def plan(root, release, commit, source_digest, module_files):
    tag = release["tag_name"]
    if release["draft"] or release["prerelease"] or not re.fullmatch(r"v\d+\.\d+\.\d+", tag):
        raise ValueError("CPA candidate must be a stable release")
    if not re.fullmatch(r"[a-f0-9]{40}", commit) or not re.fullmatch(r"[a-f0-9]{64}", source_digest):
        raise ValueError("CPA candidate needs immutable source pins")
    releases = json.loads((root / "containers/pool/releases.json").read_text())
    current = releases["artifacts"]["node"]
    if current["repository"] != REPOSITORY:
        raise ValueError("Unexpected CPA repository")
    version = lambda value: tuple(map(int, value.removeprefix("v").split(".")))
    if version(tag) <= version(current["tag"]):
        raise ValueError("CPA candidate must advance the current release")
    base = json.loads(json.dumps(current))
    current.update(tag=tag, commit=commit)
    for arch, go_arch in (("amd64", "amd64"), ("arm64", "aarch64")):
        name = f"CLIProxyAPI_{tag[1:]}_linux_{go_arch}_no-plugin.tar.gz"
        assets = [asset for asset in release["assets"] if asset["name"] == name]
        if len(assets) != 1 or not re.fullmatch(r"sha256:[a-f0-9]{64}", assets[0].get("digest", "")):
            raise ValueError(f"Missing checksum-bound release asset: {name}")
        current["assets"][arch] = {"name": name, "sha256": assets[0]["digest"][7:]}
    sources = json.loads((root / "containers/pool/sources.json").read_text())
    source = sources["artifacts"]["node"]
    if source["repository"] != REPOSITORY or source["commit"] != base["commit"]:
        raise ValueError("Current CPA source and release disagree")
    for carry in source["patches"]:
        path = Path(carry["file"])
        if path.name != str(path) or hashlib.sha256((root / "containers/pool/patches" / path).read_bytes()).hexdigest() != carry["sha256"]:
            raise ValueError("CPA carry checksum mismatch")
    source.update(commit=commit, sha256=source_digest)
    encode = lambda value: json.dumps(value, indent=2) + "\n"
    manifest = json.loads((root / "scripts/releases/patches.json").read_text())
    manifest["pool_carries"]["content_sha256"] = hashlib.sha256(encode(sources).encode()).hexdigest()
    upstream = json.loads((root / "upstream.json").read_text())
    pins = {"tools": upstream, "home": releases["artifacts"]["home"], "node": base}
    receipt = {"schemaVersion": 2, "source": "node", "releaseKey": f"node-{tag}",
               "basePins": pins, "candidatePins": {**pins, "node": current}, "removedPatches": []}
    module = MODULE
    expected = [f"{module} {tag} ", f"{module} {tag}/go.mod "]
    sums = [line for line in module_files["go.sum"].splitlines() if line.startswith(module + " ")]
    if len(sums) != 2 or any(not any(line.startswith(prefix) and re.fullmatch(r"h1:[A-Za-z0-9+/]{43}=", line[len(prefix):]) for line in sums) for prefix in expected):
        raise ValueError("Missing CPA module checksums")
    go_mod = (root / "containers/pool/typesafe/go.mod").read_text()
    requirement = rf"(?m)^\s*(?:require\s+)?{re.escape(module)}\s+(\S+)"
    if re.findall(requirement, go_mod) != [base["tag"]]:
        raise ValueError("Native plugin pin differs from CPA")
    if re.findall(requirement, module_files["go.mod"]) != [tag]:
        raise ValueError("Regenerated native plugin pin differs from CPA")
    architecture = (root / "architecture/model/basalt.c4").read_text()
    old_version = f"Model gateway version {base['tag']}"
    if architecture.count(old_version) != 1:
        raise ValueError("Architecture CPA version differs from the release pin")
    return {
        "containers/pool/releases.json": encode(releases),
        "containers/pool/sources.json": encode(sources),
        "scripts/releases/patches.json": encode(manifest),
        "scripts/releases/receipts/node.json": encode(receipt),
        "containers/pool/typesafe/go.mod": module_files["go.mod"],
        "containers/pool/typesafe/go.sum": module_files["go.sum"],
        "architecture/model/basalt.c4": architecture.replace(old_version, f"Model gateway version {tag}"),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tag")
    parser.add_argument("--body-file", type=Path, required=True)
    args = parser.parse_args()
    release = api(f"releases/tags/{args.tag}" if args.tag else "releases/latest")
    tag = release["tag_name"]
    current = json.loads((ROOT / "containers/pool/releases.json").read_text())["artifacts"]["node"]
    if tag == current["tag"]:
        args.body_file.write_text("CPA is current.\n")
        print("CPA is current")
        return
    if not re.fullmatch(r"v\d+\.\d+\.\d+", tag):
        raise ValueError("Unexpected CPA tag")
    commit = api(f"commits/{tag}")["sha"]
    digest = hashlib.sha256()
    with urllib.request.urlopen(f"https://codeload.github.com/{REPOSITORY}/tar.gz/{commit}", timeout=120) as response:
        while chunk := response.read(1024 * 1024):
            digest.update(chunk)
    files = plan(ROOT, release, commit, digest.hexdigest(), native_module_metadata(ROOT, tag))
    for name, content in files.items():
        (ROOT / name).write_text(content)
    args.body_file.write_text(
        f"CPA {current['tag']} is behind upstream {tag}. Update the source and native plugin pins together, preserving existing carries.\n\n"
        f"Release: https://github.com/{REPOSITORY}/releases/tag/{tag}\n"
        f"Diff: https://github.com/{REPOSITORY}/compare/{current['tag']}...{tag}\n\n"
        "The Check workflow runs the pool regression suite, privacy regressions and same-socket Codex WebSocket continuation test. "
        "The CPA pipeline guard rejects edits to existing carries or runtime code. Coordinator review and merge are required.\n\n"
        f"## Upstream release notes\n\n{release.get('body', '')}\n\n"
        "Generated by the deterministic CPA updater in GitHub Actions.\n")


if __name__ == "__main__":
    main()
