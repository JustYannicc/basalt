import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { assertAutomaticCloudControl } from "./ci/server-control.ts";

test("automatic Cloud assignments refuse direct and helper lifecycle calls, while explicit Cloud jobs retain target-aware fixtures", () => {
  const root = mkdtempSync(join(tmpdir(), "basalt-cloud-control-"));
  const e2e = join(root, ".upstream/e2e");
  mkdirSync(join(e2e, "tests"), { recursive: true });
  mkdirSync(join(e2e, "support"));
  const write = (file: string, source: string) => writeFileSync(join(e2e, file), source);
  try {
    write(
      "tests/direct.spec.ts",
      'import { serverControl as control } from "../support/server-control.ts"; control("restart");',
    );
    write(
      "support/fixture.ts",
      'import { serverControl } from "./server-control.ts"; export const fixture = () => serverControl("start");',
    );
    write("tests/helper.spec.ts", 'import { fixture } from "../support/fixture.ts"; fixture();');
    for (const file of ["direct.spec.ts", "helper.spec.ts"])
      assert.throws(
        () => assertAutomaticCloudControl(root, file, true),
        /automatic declared:cloud.*serverControl.*Existing explicit Cloud jobs/,
      );
    assert.doesNotThrow(() => assertAutomaticCloudControl(root, "direct.spec.ts", false));
    write("support/case.ts", 'import { serverControl } from "./server-control.ts";');
    write("tests/ordinary.spec.ts", 'import { withHostedCase } from "../support/case.ts";');
    assert.doesNotThrow(() => assertAutomaticCloudControl(root, "ordinary.spec.ts", true));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
