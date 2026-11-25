// The workflow's first step after checkout: no credential is in this step's environment yet.
import { guard } from "./settings.ts";

const { stage, mode } = guard();
console.log(JSON.stringify({ routeScratchGuard: "passed", stage, mode }));
