# Run the fast CI gate before pushing

Use `npm run ci:fast -- --base origin/main` when the candidate is committed and the checkout is clean. It catches the format, lint and type errors checked by the ordinary pull request fast job before they consume a remote CI cycle.

Prepare the checkout with `HEAVY_SLOTS=6 heavy-slot npm run prepare:upstream` first. Use the exact Node and Bun versions declared by the `fast` job. Fetch the intended target before choosing `--base`; the command resolves the target and candidate to immutable commits without fetching or changing branches.

The complete command automatically enters `heavy-slot` before running any checks, using six machine-wide slots by default. It fails if the wrapper is unavailable and waits while the machine-wide pause is active. A command already running inside a slot reuses that slot. The `--list` option only reads the plan and needs no slot.

Preparation installs dependencies and builds setup assets. The framework reference build, deployment generation and upstream typecheck can also build generated inputs. These steps require the slot even though they belong to the fast job. During a pause, use named format, type, lint, registry, LikeC4 or fitness checks directly against an already prepared checkout. Those partial checks do not establish a complete fast-gate pass.

The command reads `.github/workflows/ci.yml` and runs every applicable shell step in `fast`, in order, with its environment and working directory. It follows the ordinary PR fast lane. The reviewed fast/full conditions select focused checks and skip full-lane-only commands; skipped steps appear in the plan, console and result record. It stops at the first failure. Preparation rebuilds the generated `.upstream` checkout, just as CI does. Save carry work before running it.

`npm run ci:fast -- --base origin/main --list` prints the resolved commits and commands without running checks. A completed run keeps its commit-bound result under `.generated/ci-fast/`.

The workflow is the command list. Adding an unsupported action, expression, condition or custom shell fails locally until the runner understands it. Local Linux and macOS use the same actionlint version and checked release archives as CI. ShellCheck must be installed and available on PATH; the launcher fails before linting when it is missing, so local workflow checking retains CI shell diagnostics.

This command runs the complete ordinary PR fast lane; it does not establish full-suite merge eligibility. Targeted checks are useful while editing; only a complete successful `ci:fast` run establishes local fast-gate parity. Heavy product suites remain in the full CI lane.
