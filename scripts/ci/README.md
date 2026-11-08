# Run the fast CI gate before pushing

Use `npm run ci:fast -- --base origin/main` when the candidate is committed and the checkout is clean. It catches the format, lint and type errors checked by the ordinary pull request fast job before they consume a remote CI cycle.

Prepare the checkout with `HEAVY_SLOTS=6 heavy-slot npm run prepare:upstream` first. Use the exact Node and Bun versions declared by the `fast` job. Fetch the intended target before choosing `--base`; the command resolves the target and candidate to immutable commits without fetching or changing branches.

The complete command automatically enters `heavy-slot` before running any checks, using six machine-wide slots by default. It fails if the wrapper is unavailable and waits while the machine-wide pause is active. A command already running inside a slot reuses that slot. The `--list` option only reads the plan and needs no slot.

Preparation installs dependencies and builds setup assets. The framework reference build, deployment generation and upstream typecheck can also build generated inputs. These steps require the slot even though they belong to the fast job. During a pause, use named format, type, lint, registry, LikeC4 or fitness checks directly against an already prepared checkout. Those partial checks do not establish a complete fast-gate pass.

The command reads `.github/workflows/ci.yml` and runs every applicable shell step in `fast`, in order, with its environment and working directory. It follows the ordinary PR fast lane. The reviewed fast/full conditions select focused checks and skip full-lane-only commands; skipped steps appear in the plan, console and result record. It stops at the first failure. Preparation rebuilds the generated `.upstream` checkout, just as CI does. Save carry work before running it.

`npm run ci:fast -- --base origin/main --list` prints the resolved commits and commands without running checks. A completed run keeps its commit-bound result under `.generated/ci-fast/`.

The workflow is the command list. Adding an unsupported action, expression, condition or custom shell fails locally until the runner understands it. Local Linux and macOS use the same actionlint version and checksum-pinned Go source as CI. Cold builds use the Go module proxy; warm binaries and official Bun npm archives use versioned CI caches. Node downloads use the official distribution host. ShellCheck must be installed and available on PATH; the launcher fails before linting when it is missing, so local workflow checking retains CI shell diagnostics.

This command runs the complete ordinary PR fast lane; it does not establish full-suite merge eligibility. Targeted checks are useful while editing; only a complete successful `ci:fast` run establishes local fast-gate parity. Heavy product suites remain in the full CI lane.

After changing `upstream.json`, fetch its exact commit into `.upstream` and run `node scripts/ci/snapshot-upstream-inputs.ts` to regenerate the input file inventory. The command reads that commit's Git tree; prepared or untracked files do not enter the snapshot. The coverage gate independently checks the snapshot against the pin.

## Keep e2e coverage explicit

`bun scripts/ci/check-e2e-coverage.ts` runs in the fast lane after preparation. It names test calls and standalone checks that no declared runner or workflow reaches. Wire each omission into a CI group or job, or add a reviewed entry to `scripts/ci/e2e-exceptions.json` with a reason and the exact fingerprint from `.generated/ci/e2e-coverage.json`. The fingerprint includes the prepared spec and its plan. Changed fingerprints require renewed review, and selected or deleted entries must be removed. Exceptions never expand automatically to new tests in the same file.

`--no-exceptions` reports the full ungated inventory, including the frozen inherited baseline. A temporary exception for a broken check must name its owning fix. Wiring that check makes the exception fail, so the fix removes both together.
