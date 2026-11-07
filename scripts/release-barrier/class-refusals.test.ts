import assert from "node:assert/strict";
import { test } from "node:test";
import { assertClassRequests } from "./class-refusals.ts";
import { preparedUpload } from "./fixture.ts";
import { BarrierRefusal } from "./manifest.ts";

test("all independent concrete request refusals name their logical Worker before any live expansion", () => {
  const uploads = ["First", "Second"].map((fqn) => {
    const upload = preparedUpload(fqn);
    const next = {
      ...upload,
      request: {
        ...upload.request,
        metadata: {
          ...upload.request.metadata,
          migrations: { newSqliteClasses: ["Undeclared"] },
        },
      },
    };
    return [fqn, next] as const;
  });
  assert.throws(
    () => assertClassRequests({ captured: new Map(uploads) }, [], {}),
    (error) => {
      assert.ok(error instanceof BarrierRefusal);
      assert.deepEqual(
        error.refusals?.map((refusal) => ("fqn" in refusal ? refusal.fqn : null)),
        ["First", "Second"],
      );
      assert.ok(
        error.refusals?.every((refusal) => "changed" in refusal && refusal.changed.length > 0),
      );
      return true;
    },
  );
});
