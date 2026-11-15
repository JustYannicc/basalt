import { appendFileSync } from "node:fs";
import { SafetyGateError } from "./contracts.ts";
import type { FrameworkReleaseProvenance } from "./framework-qualification.ts";

type Difference = {
  resource: string;
  property: string;
  expected: string | number;
  observed: string | number;
};

export function frameworkDifferences(
  resource: string,
  expected: FrameworkReleaseProvenance,
  observed: FrameworkReleaseProvenance,
): Difference[] {
  const fields = ["version", "sha256", "protocol", "browserSha256"] as const;
  const sourceFields = ["origin", "revision", "sha256"] as const;
  return [
    ...fields.flatMap((property) =>
      expected[property] === observed[property]
        ? []
        : [{ resource, property, expected: expected[property], observed: observed[property] }],
    ),
    ...sourceFields.flatMap((property) =>
      expected.source[property] === observed.source[property]
        ? []
        : [
            {
              resource,
              property: `source.${property}`,
              expected: expected.source[property],
              observed: observed.source[property],
            },
          ],
    ),
  ];
}

/** Only parsed provenance fields and computed digests reach release logs and summaries. */
export function refuseFramework(reason: string, differences: readonly Difference[]): never {
  const clean = (value: string | number) => JSON.stringify(value).replaceAll("`", "\\u0060");
  const diagnostic = `${reason}:\n${differences
    .map(
      (difference) =>
        `${clean(difference.resource)} ${difference.property}: expected ${clean(difference.expected)}; observed ${clean(difference.observed)}`,
    )
    .join("\n")}`;
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary)
    appendFileSync(
      summary,
      `\nFramework qualification refused\n\n\`\`\`text\n${diagnostic}\n\`\`\`\n`,
    );
  throw new SafetyGateError(diagnostic);
}
