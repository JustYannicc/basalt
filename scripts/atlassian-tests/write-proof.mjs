import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { atlassianPeople } from "./provider.mjs";

const call = (client, name, args) => client.callTool({ name, arguments: args });
const text = (result) => JSON.stringify(result.structuredContent ?? result);

/** Discover exact paths so a large generated catalog cannot hide the named operations. */
export async function discover(client, slug, names) {
  const paths = {};
  for (const name of names) {
    const path = `tools[${JSON.stringify(slug)}].${name}`;
    const result = await call(client, "search", { query: path, limit: 1 });
    assert.ok(!result.isError, `Search failed: ${path}`);
    assert.ok(
      result.structuredContent?.items?.some((item) => item.path === path),
      `Missing actual catalog tool ${path}`,
    );
    paths[name] = path;
  }
  return paths;
}

export async function proveAtlassianWrites({
  clients,
  accounts,
  provider,
  slug,
  directory,
  check,
}) {
  const names = [
    "jira.issues.createIssue",
    "jira.issues.editIssue",
    "jira.issues.deleteIssue",
    "serviceManagement.request.createCustomerRequest",
    "serviceManagement.servicedesk.createRequestType",
    "serviceManagement.request.getCommentAttachments",
    "confluence.space.createSpace",
    "confluenceV2.page.createPage",
    "confluenceV2.page.getPageById",
    "confluenceV2.page.updatePage",
    "confluenceV2.page.deletePage",
    "confluence.contentWatches.addContentWatcher",
  ];
  const paths = await discover(clients[0], slug, names);
  const evidence = (operation, result) =>
    appendFileSync(join(directory, "writes.jsonl"), `${JSON.stringify({ operation, result })}\n`, {
      mode: 0o600,
    });
  const pending = async (client, name, input) => {
    const before = provider.writes.length;
    const result = await call(client, "call", { calls: { path: paths[name], input } });
    evidence(name, result);
    check(result.structuredContent?.status === "approval-required", `${name} requires approval`);
    check(
      typeof result.structuredContent.requestId === "string",
      `${name} returns a saved approval request`,
    );
    check(provider.writes.length === before, `${name} cannot write before approval`);
    return result.structuredContent.requestId;
  };
  const resume = (client, requestId, action) =>
    call(client, "resume", { requestId, response: { action } });
  const write = async (client, name, input, person) => {
    const before = provider.writes.length;
    const requestId = await pending(client, name, input);
    const result = await resume(client, requestId, "accept");
    evidence(`${name}:accept`, result);
    check(
      result.structuredContent?.status === "completed" &&
        result.structuredContent?.execution?.ok === true &&
        result.structuredContent?.execution?.value?.ok === true,
      `${name} approval runs the real router successfully`,
    );
    check(provider.writes.length === before + 1, `${name} reaches the API exactly once`);
    check(provider.writes.at(-1).person === person.key, `${name} uses the caller's grant`);
    return result;
  };
  for (const [index, client] of clients.entries()) {
    const person = atlassianPeople[index];
    const peer = clients[1 - index];
    const path = { cloudId: person.cloudId };
    const create = {
      path,
      body: {
        fields: {
          summary: person.jiraMarker,
          project: { key: person.key.toUpperCase() },
          issuetype: { name: "Task" },
        },
      },
    };
    const before = provider.writes.length;
    const declinedId = await pending(client, "jira.issues.createIssue", create);
    const peerResult = await resume(peer, declinedId, "accept");
    evidence("peer-resume", peerResult);
    check(
      peerResult.isError || peerResult.structuredContent?.execution?.ok !== true,
      "Peer cannot resume the caller's write",
    );
    check(provider.writes.length === before, "Peer approval cannot reach the API");
    const declined = await resume(client, declinedId, "decline");
    evidence("declined", declined);
    check(
      text(declined).includes("denied") ||
        text(declined).includes("Declined") ||
        text(declined).includes("ApprovalDenied"),
      "Declining ends the saved write",
    );
    check(provider.writes.length === before, "Declined write never reaches the API");
    const forged = await call(client, "call", {
      calls: {
        path: paths["jira.issues.createIssue"],
        input: {
          ...create,
          $accounts: { atlassian: accounts[1 - index] },
        },
      },
    });
    check(
      text(forged).includes("AccountChoiceUnsupported"),
      "Generated writes refuse peer account selection",
    );
    check(provider.writes.length === before, "Forged account selection cannot write");
    await write(client, "jira.issues.createIssue", create, person);
    await write(
      client,
      "jira.issues.editIssue",
      {
        path: { ...path, issueIdOrKey: person.issueKey },
        body: { fields: { summary: `${person.jiraMarker}_EDITED` } },
      },
      person,
    );
    await write(
      client,
      "jira.issues.deleteIssue",
      { path: { ...path, issueIdOrKey: person.issueKey } },
      person,
    );
    await write(
      client,
      "serviceManagement.request.createCustomerRequest",
      {
        path,
        body: {
          serviceDeskId: "10",
          requestTypeId: "25",
          requestFieldValues: { summary: person.jiraMarker },
        },
      },
      person,
    );
    await write(
      client,
      "serviceManagement.servicedesk.createRequestType",
      {
        path: { ...path, serviceDeskId: "10" },
        body: {
          name: person.jiraMarker,
          issueTypeId: "10000",
          description: "Synthetic request type",
          helpText: "Synthetic",
        },
      },
      person,
    );
    const attachments = await call(client, "call", {
      calls: {
        path: paths["serviceManagement.request.getCommentAttachments"],
        input: { path: { ...path, issueIdOrKey: person.issueKey, commentId: 1 } },
      },
    });
    evidence("experimental-attachments", attachments);
    check(
      !attachments.isError && text(attachments).includes("isLastPage"),
      "Experimental JSM read sends the required opt-in header",
    );
    await write(
      client,
      "confluence.space.createSpace",
      { path, body: { key: person.key.toUpperCase(), name: person.pageMarker } },
      person,
    );
    const pageId = index === 0 ? "9101" : "9202";
    const flatBody = { representation: "storage", value: `<p>${person.pageMarker}</p>` };
    const pageBody = index === 0 ? flatBody : { storage: flatBody };
    await write(
      client,
      "confluenceV2.page.createPage",
      {
        path,
        body: { spaceId: "10", title: person.pageMarker, status: "current", body: pageBody },
      },
      person,
    );
    const read = await call(client, "call", {
      calls: {
        path: paths["confluenceV2.page.getPageById"],
        input: { path: { ...path, id: Number(pageId) } },
      },
    });
    evidence("read-created-page", read);
    check(
      !read.isError && text(read).includes(person.pageMarker),
      "Generated page read returns the created page",
    );
    const crossSite = await call(client, "call", {
      calls: {
        path: paths["confluenceV2.page.getPageById"],
        input: { path: { cloudId: atlassianPeople[1 - index].cloudId, id: Number(pageId) } },
      },
    });
    check(
      !text(crossSite).includes(atlassianPeople[1 - index].pageMarker),
      "Own grant cannot read a peer's site",
    );
    check(provider.apiRequests().at(-1).status === 403, "Provider refuses the mismatched cloud ID");
    await write(
      client,
      "confluenceV2.page.updatePage",
      {
        path: { ...path, id: Number(pageId) },
        body: {
          id: pageId,
          title: `${person.pageMarker}_EDITED`,
          status: "current",
          body: pageBody,
          version: { number: 2 },
        },
      },
      person,
    );
    await write(
      client,
      "confluenceV2.page.deletePage",
      { path: { ...path, id: Number(pageId) } },
      person,
    );
    await write(
      client,
      "confluence.contentWatches.addContentWatcher",
      { path: { ...path, contentId: pageId } },
      person,
    );
  }
  return {
    generatedWriteRouters: 4,
    approvedWrites: provider.writes.length,
    declinedWrites: 2,
    peerApprovalDenied: true,
    generatedAccountSelectionDenied: true,
    requiredHeadersVerified: true,
  };
}
