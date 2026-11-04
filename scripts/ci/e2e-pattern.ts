import { patternForConfig, patternForGroup } from "./declarations.ts";
console.log(
  process.argv[2] === "--config"
    ? patternForConfig(process.argv[3] ?? "")
    : patternForGroup(process.argv[2] ?? "", process.argv[3]),
);
