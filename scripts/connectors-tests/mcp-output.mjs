import assert from "node:assert/strict";

/** Read the pinned MCP call envelope before accepting an app tool's outcome. */
export function singleCallOutcome(result, path) {
  assert.notEqual(result.isError, true, "The MCP call itself failed");
  const response = result.structuredContent;
  assert.equal(response?.status, "completed", "The MCP call did not complete");
  assert.equal(response.execution?.ok, true, "The MCP execution failed");
  const outcome = response.execution.value;
  assert.equal(outcome?.path, path, "The MCP result belongs to another tool");
  assert.equal(typeof outcome.ok, "boolean", "The MCP tool outcome is missing");
  return outcome;
}

/** A successful MCP transport can still contain a failed app tool call. */
export function singleCallValue(result, path) {
  const outcome = singleCallOutcome(result, path);
  assert.equal(outcome.ok, true, "The app tool call failed");
  return outcome.value;
}
