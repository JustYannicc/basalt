"""Reject new CPA pipeline edits when advancing its release pin."""

import argparse
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]
PIN_PATHS = {
    "containers/pool/releases.json", "containers/pool/sources.json",
    "containers/pool/typesafe/go.mod", "containers/pool/typesafe/go.sum",
}


def carry_edits(patch):
    # Hunk offsets and context can change when upstream moves surrounding imports.
    return [line for line in patch.splitlines() if line.startswith(("diff --git ", "+", "-"))]


def check(root, base):
    def before(path):
        return subprocess.check_output(["git", "show", f"{base}:{path}"], cwd=root, text=True)

    old = json.loads(before("containers/pool/sources.json"))
    new = json.loads((root / "containers/pool/sources.json").read_text())
    old_node, new_node = old["artifacts"]["node"], new["artifacts"]["node"]
    if old_node["commit"] == new_node["commit"]:
        print("CPA source pin unchanged")
        return
    if old_node["repository"] != new_node["repository"]:
        raise ValueError("CPA upstream repository changed")
    old_carries = old_node["patches"]
    if len(old_carries) != len(new_node["patches"]):
        raise ValueError("CPA carries changed")
    for left, right in zip(old_carries, new_node["patches"]):
        if {k: v for k, v in left.items() if k != "sha256"} != {k: v for k, v in right.items() if k != "sha256"}:
            raise ValueError("CPA carry identity or authority changed")
        path = "containers/pool/patches/" + left["file"]
        if carry_edits(before(path)) != carry_edits((root / path).read_text()):
            raise ValueError("CPA carry changes request pipeline or diagnostic behavior")
    paths = subprocess.check_output(["git", "diff", "--name-only", base, "--", "containers/pool"], cwd=root, text=True).splitlines()
    allowed = PIN_PATHS | {"containers/pool/patches/" + item["file"] for item in old_carries}
    for path in paths:
        if path not in allowed and not path.endswith(("_test.go.tmpl", ".test.ts")):
            raise ValueError(f"CPA bump changes runtime code: {path}")
    print("CPA pipeline unchanged; existing carry edits are identical")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", required=True)
    args = parser.parse_args()
    check(ROOT, args.base)
