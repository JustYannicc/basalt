"""Measure cached-image pool startup against a disposable local Postgres."""
import argparse
import json
import pathlib
import math
import platform
import os
import statistics
import subprocess
import time
import urllib.error
import urllib.request
import uuid


def docker(*args):
    return subprocess.check_output(["docker", *args], text=True, stderr=subprocess.PIPE).strip()


def ready(origin, timeout=180):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            request = urllib.request.Request(origin + "/ready", headers={"Authorization": "Bearer fixture-management-key"})
            with urllib.request.urlopen(request, timeout=2) as response:
                if response.status == 200:
                    return json.load(response)
        except (OSError, urllib.error.URLError):
            pass
        time.sleep(0.1)
    raise RuntimeError("Isolated pool did not become ready")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--arch", required=True)
    parser.add_argument("--native", action="store_true")
    parser.add_argument("--runs", type=int, default=5)
    parser.add_argument("--output", type=pathlib.Path, required=True)
    args = parser.parse_args()
    if args.native:
        assert args.arch == "amd64" and platform.machine() == "x86_64", "Native amd64 host required"
        assert docker("info", "--format", "{{.Architecture}}") in ("x86_64", "amd64"), "Native amd64 Docker required"
    token = "gemini-bench-" + uuid.uuid4().hex[:12]
    postgres, network = token + "-pg", token + "-net"
    containers = []
    records = []
    result = {"architecture": args.arch, "runs": args.runs, "environment": f"{platform.system()}/{platform.machine()}; cached images; 256 MiB pool memory; local PostgreSQL 17.7; 100 ms readiness sampling", "images": {}, "records": records}
    try:
        docker("network", "create", network)
        docker("run", "--detach", "--name", postgres, "--network", network,
               "--tmpfs", "/var/lib/postgresql/data:rw,size=256m", "--memory", "256m",
               "--env", "POSTGRES_USER=fixture_root", "--env", "POSTGRES_PASSWORD=fixture-only",
               "--env", "POSTGRES_DB=postgres", "postgres:17.7-alpine")
        for _ in range(200):
            if subprocess.run(["docker", "exec", postgres, "pg_isready", "-U", "fixture_root"], capture_output=True).returncode == 0:
                break
            time.sleep(0.1)
        else:
            raise RuntimeError("Isolated Postgres not ready")
        for variant in ("alpine", "bookworm"):
            image = f"basalt-gemini:{variant}-{args.arch}"
            docker("run", "--rm", "--platform", f"linux/{args.arch}", "--entrypoint", "/bin/true", image)
            info = json.loads(docker("image", "inspect", image))[0]
            # OCI layer sizes from Docker history are independent of local unpack state.
            history = docker("history", "--no-trunc", "--human=false", "--format", "{{.Size}}", image)
            result["images"][variant] = {"image": image, "id": info["Id"], "docker_size_bytes": info["Size"], "uncompressed_layer_bytes": sum(int(row) for row in history.splitlines())}
        for run in range(args.runs):
            for variant in (("alpine", "bookworm") if run % 2 == 0 else ("bookworm", "alpine")):
                image = f"basalt-gemini:{variant}-{args.arch}"
                database = f"sample_{run}_{variant}"
                docker("exec", postgres, "createdb", "-U", "fixture_root", database)
                name = f"{token}-{run}-{variant}"
                docker("create", "--name", name, "--network", network, "--platform", f"linux/{args.arch}",
                       "--memory", "256m", "--publish", "127.0.0.1::8318",
                       "--env", f"POOL_DATABASE_URL=postgresql://fixture_root:fixture-only@{postgres}:5432/{database}",
                       "--env", "POOL_MANAGEMENT_KEY=fixture-management-key", image)
                containers.append(name)
                for state in ("fresh", "retained"):
                    start = time.monotonic()
                    docker("start", name)
                    mapping = docker("port", name, "8318")
                    status = ready("http://" + mapping)
                    elapsed_ms = round((time.monotonic() - start) * 1000, 2)
                    logs = docker("logs", name)
                    phases = [json.loads(line.removeprefix("POOL_STARTUP_PHASE ")) for line in logs.splitlines() if line.startswith("POOL_STARTUP_PHASE ")]
                    ends = [phase for phase in phases if phase["phase"] == "initial_health"]
                    record = {"variant": variant, "run": run + 1, "database": state, "start_to_ready_ms": elapsed_ms, "supervisor_to_ready_ms": ends[-1]["end_ms"], "boot_id": status["boot_id"]}
                    records.append(record)
                    print(json.dumps(record), flush=True)
                    args.output.write_text(json.dumps(result, indent=2) + "\n")
                    docker("stop", "--time", "20", name)
                docker("rm", name)
                containers.remove(name)
                docker("exec", postgres, "dropdb", "-U", "fixture_root", database)
        result["summary"] = {}
        for variant in ("alpine", "bookworm"):
            for state in ("fresh", "retained"):
                values = [r["start_to_ready_ms"] for r in records if r["variant"] == variant and r["database"] == state]
                result["summary"][variant + "_" + state] = {"median_ms": statistics.median(values), "min_ms": min(values), "max_ms": max(values), "p90_ms": sorted(values)[math.ceil(len(values) * 0.9) - 1]}
        result["retained_median_delta_ms"] = round(result["summary"]["bookworm_retained"]["median_ms"] - result["summary"]["alpine_retained"]["median_ms"], 2)
        args.output.write_text(json.dumps(result, indent=2) + "\n")
        summary_path = os.environ.get("GITHUB_STEP_SUMMARY")
        if summary_path:
            with open(summary_path, "a") as out:
                out.write("## Native amd64 pool readiness\n\n")
                out.write(f"{args.runs} samples per image and database state, alternating image order. Cached images; 100 ms readiness sampling. Image pull is excluded.\n\n")
                out.write("| Image | Database | Median, s | p90, s | Uncompressed layers, MB |\n| --- | --- | ---: | ---: | ---: |\n")
                for variant in ("alpine", "bookworm"):
                    for state in ("fresh", "retained"):
                        row = result["summary"][variant + "_" + state]
                        size = result["images"][variant]["uncompressed_layer_bytes"] / 1_000_000
                        out.write(f"| {variant} | {state} | {row['median_ms']/1000:.3f} | {row['p90_ms']/1000:.3f} | {size:.3f} |\n")
                out.write(f"\nRetained-database median delta: {result['retained_median_delta_ms']/1000:+.3f} s. Merge hold above +1.000 s.\n")
        print(json.dumps(result["summary"], indent=2), flush=True)
        if args.native and result["retained_median_delta_ms"] > 1000:
            raise RuntimeError("Native amd64 retained-database median regressed by more than one second; hold the ready PR")
    finally:
        for name in containers:
            subprocess.run(["docker", "rm", "--force", name], capture_output=True)
        subprocess.run(["docker", "rm", "--force", "--volumes", postgres], capture_output=True)
        subprocess.run(["docker", "network", "rm", network], capture_output=True)


if __name__ == "__main__":
    main()
