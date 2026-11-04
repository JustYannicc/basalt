# Run the fast CI gate before pushing

Use `npm run ci:fast -- --base origin/main` when the candidate is committed and the checkout is clean. It catches the format, lint and patched-upstream type errors that otherwise consume a remote CI cycle.

Prepare the checkout with `npm run prepare:upstream` first. Use the exact Node and Bun versions declared by the `fast` job. Fetch the intended target before choosing `--base`; the command resolves the target and candidate to immutable commits without fetching or changing branches.

The command reads `.github/workflows/ci.yml` and runs every shell step in `fast`, in order, with its environment and working directory. This includes fresh carry preparation, changed-file formatting and lint, workflow syntax, app checks, architecture checks, unit tests and all normal typechecks. It stops at the first failure. Preparation rebuilds the generated `.upstream` checkout, just as CI does. Save carry work before running it.

`npm run ci:fast -- --base origin/main --list` prints the resolved commits and commands without running checks. A completed run keeps its commit-bound result under `.generated/ci-fast/`.

The workflow is the command list. Adding an unsupported action, expression, conditional step or custom shell fails locally until the runner understands it. Local Linux and macOS use the same actionlint version and checked release archives as CI.

This command runs the whole fast job. Targeted checks are useful while editing; only a complete successful `ci:fast` run establishes local fast-gate parity. Heavy product suites remain in the full CI lane.
