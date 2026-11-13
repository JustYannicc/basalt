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


def check(root, base, head=None):
    def before(path):
        return subprocess.check_output(["git", "show", f"{base}:{path}"], cwd=root, text=True)

    def current(path):
        if head is None:
            return (root / path).read_text()
        return subprocess.check_output(["git", "show", f"{head}:{path}"], cwd=root, text=True)

    old = json.loads(before("containers/pool/sources.json"))
    new = json.loads(current("containers/pool/sources.json"))
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
        if carry_edits(before(path)) != carry_edits(current(path)):
            raise ValueError("CPA carry changes request pipeline or diagnostic behavior")
    paths = subprocess.check_output(["git", "diff", "--name-only", base, *([head] if head else []), "--", "containers/pool"], cwd=root, text=True).splitlines()
    allowed = PIN_PATHS | {"containers/pool/patches/" + item["file"] for item in old_carries}
    for path in paths:
        if path not in allowed and not path.endswith(("_test.go.tmpl", ".test.ts")):
            raise ValueError(f"CPA bump changes runtime code: {path}")
    print("CPA pipeline unchanged; existing carry edits are identical")


def check_batch(root, base, head):
    def git(*args):
        return subprocess.check_output(["git", *args], cwd=root, text=True).strip()

    subprocess.run(["git", "merge-base", "--is-ancestor", base, head], cwd=root, check=True)
    commits = git("rev-list", "--first-parent", "--reverse", f"{base}..{head}").splitlines()
    for commit in commits:
        parents = git("rev-list", "--parents", "-n", "1", commit).split()[1:]
        if len(parents) > 2:
            raise ValueError(f"CPA attribution refuses octopus merge {commit}")
        # A merge's second parent is the immutable member head, including all its commits.
        member = parents[1] if len(parents) == 2 else commit
        member_base = git("merge-base", parents[0], member) if len(parents) == 2 else parents[0]
        try:
            check(root, member_base, member)
        except ValueError as error:
            raise ValueError(f"CPA member {member_base}..{member}: {error}") from error


def check_main_push(root, base, head):
    def git(*args):
        return subprocess.check_output(["git", *args], cwd=root, text=True).strip()

    parents = git("rev-list", "--parents", "-n", "1", head).split()[1:]
    if len(parents) == 2:
        first, second = parents
        common = git("merge-base", first, second)
        merges = git("rev-list", "--first-parent", "--min-parents=2", f"{common}..{second}").splitlines()
        members = []
        for merge in merges:
            member = git("rev-parse", f"{merge}^2")
            landed = subprocess.run(["git", "merge-base", "--is-ancestor", member, first], cwd=root)
            if landed.returncode not in (0, 1):
                landed.check_returncode()
            # Merging main into an ordinary update does not create a reviewed member.
            if landed.returncode == 1:
                members.append(merge)
        if members:
            # Main wraps the composed head in one merge; members remain on the second parent.
            print(f"CPA main merge uses batch attribution; base {first}; batch base {common}")
            check_batch(root, common, second)
            check(root, second, head)
            return
    check(root, base, head)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", required=True)
    parser.add_argument("--head")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--batch", action="store_true")
    mode.add_argument("--main-push", action="store_true")
    args = parser.parse_args()
    if args.main_push:
        check_main_push(ROOT, args.base, args.head or "HEAD")
    elif args.batch:
        check_batch(ROOT, args.base, args.head or "HEAD")
    else:
        check(ROOT, args.base, args.head)
