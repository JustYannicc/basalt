import { changedInputs } from "./affected.ts";
import { styleSteps } from "./style-steps.ts";
import { run } from "../process.ts";

const root = process.cwd();
const { inputs } = changedInputs(root, process.env.BASE_SHA ?? "", process.env.HEAD_SHA ?? "");
for (const step of styleSteps(inputs)) run(step.command, step.args, step.cwd);
