# Carry constraints

Each added or changed carry records its durable constraint in `<stem>.c4`, matching
`patches/<stem>.patch` and its JSON record. Record-only updates also update this file.
Rename the file when renumbering a carry. On retirement, remove its constraint file
and update any affected model responsibilities or relationships.

Each file contains exactly one model block extending the affected element by its full name, with exactly one `constraint` metadata entry. Its value is a non-empty JSON-quoted string. Use JSON escapes for quotes or newlines. For example:

```c4
model {
  extend basalt.build {
    metadata {
      constraint "Generated renderer bytes and content-hashed paths must use the same pinned build tool."
    }
  }
}
```

LikeC4 loads files in this directory into the same model. Constraints from separate
files accumulate as metadata on the element, so concurrent carries do not append
to one shared description. Keep module responsibilities and structural relationships
in the area files. Existing prose can stay until its carry changes; put the updated
constraint here instead of appending to a shared description.

Fitness requires a changed matching file for each active carry changed by the PR. It validates the defined shape and non-empty statement of every existing carry file, including unchanged files. Deleting a constraint file while its carry remains active fails. Untouched legacy carries without per-carry files stay grandfathered. LikeC4 validation checks syntax and element references.
