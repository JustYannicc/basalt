import { writeFileSync } from "node:fs";

let uncaught = false;
// Monitoring leaves Node's exception handling and exit status intact.
process.on("uncaughtExceptionMonitor", () => { uncaught = true; });
process.on("exit", (code) => writeFileSync(process.env.BASALT_CI_PROCESS_REPORT, JSON.stringify({ code, uncaught })));
