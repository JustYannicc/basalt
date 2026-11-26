// The workflow's first step after checkout: no credential is in this step's environment yet.
import { guard } from "./settings.ts";

console.log(JSON.stringify({ emulatedUpstreamGuard: "passed", mode: guard() }));
