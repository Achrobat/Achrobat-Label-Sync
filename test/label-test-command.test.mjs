import assert from "node:assert/strict";
import test from "node:test";

import { validateLabelTestWorkflowConfig } from "../scripts/lib/config-validation.mjs";
import { handleLabelTestCommand } from "../scripts/run-label-test-command.mjs";

const LABEL = "Waiting on PR";
const BOT = "label-sync[bot]";

function makeConfig(commandDelivery) {
  return validateLabelTestWorkflowConfig({
    failingLabels: [LABEL],
    waitForMerge: { label: LABEL, allowedUsers: "Alice" },
    ...(commandDelivery ? { commandDelivery } : {}),
  });
}

function comment(id, login, body, { type = "User", issue = "Org/repo/issues/5" } = {}) {
  return {
    id,
    body,
    created_at: "2026-10-01T00:00:00Z",
    issue_url: `https://api.github.com/repos/${issue}`,
    user: { login, type },
  };
}

// A small in-memory GitHub for one pull request, Org/repo#5, which links to an open pull request Org/lib#42.
function createFakeGithub({ comments = [], issueIsPullRequest = true } = {}) {
  const state = { labels: [], comments: [...comments], writes: [] };
  const request = async (method, apiPath, body) => {
    const pathOnly = apiPath.replace(/\?.*$/, "");
    const page = Number(/[?&]page=(\d+)/.exec(apiPath)?.[1] ?? 1);
    let match;

    if (method !== "GET") {
      state.writes.push(`${method} ${pathOnly}`);
    }
    if (method === "GET" && (match = /^\/repos\/Org\/repo\/issues\/comments\/(\d+)$/.exec(pathOnly))) {
      const found = state.comments.find((item) => String(item.id) === match[1]);
      if (!found) {
        const error = new Error("Not Found");
        error.status = 404;
        throw error;
      }
      return found;
    }
    if (method === "GET" && pathOnly === "/repos/Org/repo/issues/5") {
      return {
        number: 5,
        state: "open",
        ...(issueIsPullRequest ? { pull_request: {} } : {}),
        user: { login: "Author" },
        labels: state.labels,
      };
    }
    if (method === "GET" && /^\/repos\/Org\/repo\/issues\/5\/(comments|events)$/.test(pathOnly)) {
      return page === 1 && pathOnly.endsWith("comments") ? state.comments : [];
    }
    if (method === "GET" && pathOnly === "/repos/Org/lib/pulls/42") {
      return { state: "open" };
    }
    if (method === "POST" && pathOnly === "/repos/Org/repo/issues/5/comments") {
      state.comments.push(comment(100 + state.comments.length, BOT, body.body, { type: "Bot" }));
      return {};
    }
    if (method === "POST" && pathOnly === "/repos/Org/repo/issues/5/labels") {
      state.labels.push(...body.labels.map((name) => ({ name })));
      return state.labels;
    }
    if (method === "POST" && /\/reactions$/.test(pathOnly)) {
      return {};
    }
    throw new Error(`Unexpected ${method} ${apiPath}`);
  };
  return { state, request };
}

async function run(fake, overrides = {}) {
  return handleLabelTestCommand({
    request: fake.request,
    config: makeConfig("dispatch"),
    organization: "Org",
    source: "dispatch",
    repository: "Org/repo",
    pullRequestNumber: "5",
    commentId: "1",
    commentAction: "created",
    isTeamMember: async () => false,
    isAutomationActor: async (login) => login === BOT,
    log: () => {},
    ...overrides,
  });
}

test("commandDelivery defaults to workflow and only accepts workflow or dispatch", () => {
  assert.equal(validateLabelTestWorkflowConfig({}).commandDelivery, "workflow");
  assert.equal(validateLabelTestWorkflowConfig({ commandDelivery: "dispatch" }).commandDelivery, "dispatch");
  assert.throws(() => validateLabelTestWorkflowConfig({ commandDelivery: "webhook" }), /must be "workflow" or "dispatch"/);
});

test("a dispatched command runs exactly like one from the caller workflow", async () => {
  const fake = createFakeGithub({ comments: [comment(1, "Alice", "/wait-for-merge Org/lib#42")] });

  const result = await run(fake);

  assert.equal(result.handled, true);
  assert.equal(result.outcome.labelAdded, true);
  assert.deepEqual(fake.state.labels.map((label) => label.name), [LABEL]);
  assert.match(fake.state.comments.at(-1).body, /Org\/lib#42: open \(requested by Alice\)/);
});

test("commands arriving through the path that is not configured are ignored, so nothing runs twice", async () => {
  const fake = createFakeGithub({ comments: [comment(1, "Alice", "/wait-for-merge Org/lib#42")] });

  const fromCaller = await run(fake, { source: "workflow" });
  assert.equal(fromCaller.reason, "delivery");

  const fromDispatch = await run(fake, { config: makeConfig("workflow") });
  assert.equal(fromDispatch.reason, "delivery");

  assert.deepEqual(fake.state.writes, []);
  assert.deepEqual(fake.state.labels, []);
});

test("a dispatch is checked against the API instead of trusting its payload", async () => {
  const fake = createFakeGithub({
    comments: [
      comment(1, "Alice", "/wait-for-merge Org/lib#42", { issue: "Org/repo/issues/6" }),
      comment(2, "dependabot[bot]", "/wait-for-merge Org/lib#42", { type: "Bot" }),
      comment(3, "Alice", "thanks! /wait-for-merge Org/lib#42"),
    ],
  });

  assert.equal((await run(fake, { repository: "Elsewhere/repo" })).reason, "organization");
  assert.equal((await run(fake, { commentId: "1" })).reason, "mismatch");
  assert.equal((await run(fake, { commentId: "2" })).reason, "bot");
  assert.equal((await run(fake, { commentId: "3" })).reason, "not-command");
  assert.equal((await run(fake, { commentId: "99" })).reason, "missing");
  assert.deepEqual(fake.state.writes, []);
});

test("a dispatch naming an issue instead of a pull request changes nothing", async () => {
  const fake = createFakeGithub({
    comments: [comment(1, "Alice", "/wait-for-merge Org/lib#42")],
    issueIsPullRequest: false,
  });

  const result = await run(fake);

  assert.equal(result.handled, true);
  assert.equal(result.outcome.labelAdded, false);
  assert.deepEqual(fake.state.writes, []);
});

test("a dispatch needs well-formed values", async () => {
  const fake = createFakeGithub({ comments: [comment(1, "Alice", "/wait-for-merge Org/lib#42")] });

  await assert.rejects(run(fake, { repository: "Org/repo; rm -rf" }), /TARGET_REPOSITORY/);
  await assert.rejects(run(fake, { pullRequestNumber: "5abc" }), /PULL_REQUEST_NUMBER/);
  await assert.rejects(run(fake, { commentId: "" }), /COMMENT_ID/);
  await assert.rejects(run(fake, { commentAction: "opened" }), /COMMENT_ACTION/);
});

test("a command from the caller workflow runs with the configured token and needs no Label Test rerun", async () => {
  const fake = createFakeGithub({ comments: [comment(1, "Alice", "/wait-for-merge Org/lib#42")] });

  const result = await run(fake, { config: makeConfig("workflow"), source: "workflow", repository: "Org/repo" });

  assert.equal(result.handled, true);
  assert.equal(result.outcome.labelAdded, true);
  assert.ok(!fake.state.writes.some((write) => /actions\/runs/.test(write)), "no Label Test rerun");
});

test("the dispatch workflow passes payload values through env and has no GITHUB_TOKEN fallback", async () => {
  const { readFile } = await import("node:fs/promises");
  const workflow = await readFile(new URL("../.github/workflows/label-test-command-dispatch.yml", import.meta.url), "utf8");

  assert.match(workflow, /repository_dispatch:\n\s+types:\n\s+- pull-request-comment\n/);
  assert.match(workflow, /COMMAND_SOURCE: dispatch/);
  assert.doesNotMatch(workflow, /GITHUB_TOKEN:/);

  // Neither command workflow has a GITHUB_TOKEN fallback or grants it more than reading contents.
  const reusable = await readFile(new URL("../.github/workflows/label-test-command.yml", import.meta.url), "utf8");
  assert.doesNotMatch(reusable, /GITHUB_TOKEN:/);
  assert.match(reusable, /^permissions:\n {2}contents: read\n\n/m);
  // client_payload values may only appear in env and the concurrency group, never inside a run script.
  for (const line of workflow.split("\n").filter((item) => item.includes("client_payload"))) {
    assert.match(line, /^\s+(group|TARGET_REPOSITORY|PULL_REQUEST_NUMBER|COMMENT_ID|COMMENT_ACTION):|^#/, line);
  }
  assert.doesNotMatch(workflow, /pull_request_target|ref: \$\{\{ github\.event/);
});
