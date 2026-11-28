// Writes the mock's fixtures: the load proof's two prompts, answered exactly and at model pace.
import { writeFileSync } from "node:fs";
import { LONG_COUNT, longMatch, shortPrompt } from "./prompts.ts";

export const countingText = Array.from({ length: LONG_COUNT }, (_, i) => String(i + 1)).join("\n");
// About 800 chunks of 8 characters at 13.4 a second: one counting stream lasts about 60 s.
export const fixtures = {
  fixtures: [
    {
      match: { userMessage: longMatch },
      response: {
        content: countingText,
        usage: {
          prompt_tokens: 22,
          completion_tokens: 3000,
          input_tokens: 22,
          output_tokens: 3000,
        },
      },
      chunkSize: 8,
      streamingProfile: { ttft: 300, tps: 13.4 },
    },
    {
      match: { userMessage: shortPrompt },
      response: {
        content: "OK",
        usage: { prompt_tokens: 11, completion_tokens: 2, input_tokens: 11, output_tokens: 2 },
      },
      streamingProfile: { ttft: 200, tps: 50 },
    },
  ],
};

export const fixturesFile = new URL(
  "../../containers/emulated-upstream/fixtures/load-proof.json",
  import.meta.url,
);
export const fixturesText = () => `${JSON.stringify(fixtures)}\n`;

if (process.argv[2] === "--write") writeFileSync(fixturesFile, fixturesText());
