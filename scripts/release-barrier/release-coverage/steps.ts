import { SchemaAST } from "effect";
import { RuntimeHandoffCommand } from "../../../src/pool/runtime-slots/handoff-command.ts";
import { releaseOperations, type ReleaseOperation } from "../operation-failure.ts";
import type { RuntimeCommandAction } from "../runtime-command-rpc.ts";
import { runtimeReleasePhases, type RuntimeReleasePhase } from "../runtime-image-release-phases.ts";

/**
 * One id per thing a production release can do or refuse with. The coverage gate reads these
 * from the code itself, so a new command, operation, phase or refusal is a step the moment it exists.
 */
export type ReleaseStepId =
  | `command:${RuntimeCommandAction["action"]}`
  | `operation:${ReleaseOperation}`
  | `phase:${RuntimeReleasePhase}`
  | `refusal:${string}`;

/** `proof` names the test, preflight check or rehearsal step that drives this step under production-shaped conditions. */
export interface Coverage {
  readonly step: ReleaseStepId;
  readonly proof: string;
}

function runtimeCommandActions() {
  const literals = (ast: SchemaAST.AST): RuntimeCommandAction["action"][] => {
    if (SchemaAST.isLiteral(ast) && typeof ast.literal === "string")
      return [ast.literal as RuntimeCommandAction["action"]];
    if (SchemaAST.isUnion(ast)) return ast.types.flatMap(literals);
    throw new Error(`Runtime command action is not a closed literal (${ast._tag})`);
  };
  const members = RuntimeHandoffCommand.ast;
  if (!SchemaAST.isUnion(members)) throw new Error("Runtime commands are no longer a union");
  return members.types.flatMap((member) => {
    const action = SchemaAST.isObjects(member)
      ? member.propertySignatures.find((property) => property.name === "action")
      : undefined;
    if (!action) throw new Error("A runtime command has no action");
    return literals(action.type);
  });
}

/** Steps read from the code; refusal codes come from the source scan in scripts/architecture. */
export function releaseSteps(refusalCodes: readonly string[]): ReleaseStepId[] {
  const steps: ReleaseStepId[] = [
    ...runtimeCommandActions().map((action) => `command:${action}` as const),
    ...releaseOperations.map((operation) => `operation:${operation}` as const),
    ...runtimeReleasePhases.map((phase) => `phase:${phase}` as const),
    ...refusalCodes.map((reason): ReleaseStepId => `refusal:${reason}`),
  ];
  return [...new Set(steps)].sort();
}
