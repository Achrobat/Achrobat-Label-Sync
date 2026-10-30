import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import test from "node:test";

import { validateCommandsConfig, validateLabelTestWorkflowConfig } from "../scripts/lib/config-validation.mjs";
import { parseCommandLines } from "../scripts/lib/command-utils.mjs";
import { commandRegistry } from "../scripts/lib/commands.mjs";
import { handleLabelTestCommand } from "../scripts/run-label-test-command.mjs";
import { comment, createFakeGithub, firstPage, httpError } from "./helpers/fake-github.mjs";

const LABEL = "Waiting on PR";
const BOT = "label-sync[bot]";

function makeConfig(commands = { waitForMerge: { label: LABEL, allowedUsers: "Alice" } }) {
  const labelTestWorkflowConfig = validateLabelTestWorkflowConfig({ failingLabels: [LABEL] });
  return { ...labelTestWorkflowConfig, ...validateCommandsConfig(commands, { labelTestWorkflowConfig }) };
}

const allCommands = {
  waitForMerge: { label: LABEL, allowedUsers: "Alice" },
  team: { rules: [{ teams: ["testers"], allowedUsers: "Alice" }] },
};

// Org/repo#5 is a pull request (or an issue) that may link to the open pull request Org/lib#42. Org members
// are Alice and Bob; nobody is on the testers team yet.
function createGithub({ comments = [], isPullRequest = true } = {}) {
  const state = { labels: [], comments: [...comments], reactions: [], teamMembers: new Set() };
  const fake = createFakeGithub([
    ["GET", /^\/repos\/Org\/repo\/issues\/comments\/(\d+)$/, ({ match }) => {
      const found = state.comments.find((item) => String(item.id) === match[1]);
      if (!found) {
        throw httpError(404);
      }
      return found;
    }],
    ["GET", /^\/repos\/Org\/repo\/issues\/5$/, () => ({
      number: 5,
      state: "open",
      ...(isPullRequest ? { pull_request: {} } : {}),
      user: { login: "Author" },
      labels: state.labels,
    })],
    ["GET", /^\/repos\/Org\/repo\/issues\/5\/comments$/, firstPage(state.comments)],
    ["GET", /^\/repos\/Org\/repo\/issues\/5\/events$/, firstPage([])],
    ["GET", /^\/repos\/Org\/lib\/pulls\/42$/, () => ({ state: "open" })],
    ["POST", /^\/repos\/Org\/repo\/issues\/5\/comments$/, ({ body }) => {
      state.comments.push(comment(100 + state.comments.length, BOT, body.body, { type: "Bot" }));
      return {};
    }],
    ["POST", /^\/repos\/Org\/repo\/issues\/5\/labels$/, ({ body }) => {
      state.labels.push(...body.labels.map((name) => ({ name })));
      return state.labels;
    }],
    ["POST", /^\/repos\/Org\/repo\/issues\/comments\/(\d+)\/reactions$/, ({ match, body }) => {
      state.reactions.push(`${match[1]}:${body.content}`);
      return {};
    }],
    ["GET", /^\/orgs\/Org\/teams\/testers\/memberships\/(\w+)$/, ({ match }) => {
      if (!state.teamMembers.has(match[1])) {
        throw httpError(404);
      }
      return { state: "active" };
    }],
    ["GET", /^\/orgs\/Org\/members\/(\w+)$/, ({ match }) => {
      if (!["Alice", "Bob"].includes(match[1])) {
        throw httpError(404);
      }
      return null;
    }],
    ["PUT", /^\/orgs\/Org\/teams\/testers\/memberships\/(\w+)$/, ({ match }) => {
      state.teamMembers.add(match[1]);
      return { state: "active" };
    }],
  ]);
  return { ...fake, state };
}

async function run(github, overrides = {}) {
  return handleLabelTestCommand({
    request: github.request,
    config: makeConfig(),
    organization: "Org",
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

test("parseCommandLines reads every command line of a comment that starts with a slash", () => {
  assert.deepEqual(parseCommandLines("/team add testers\n/Wait-For-Merge #12 extra\nthanks /release v1"), [
    { name: "team", args: ["add", "testers"] },
    { name: "wait-for-merge", args: ["#12", "extra"] },
  ]);
  assert.deepEqual(parseCommandLines("please /team add testers"), []);
  assert.deepEqual(parseCommandLines("Notes\n/release v1.2.0", { requireLeadingCommand: false }), [{ name: "release", args: ["v1.2.0"] }]);
  assert.deepEqual(parseCommandLines(null), []);
});

test("every registered command has a name, an enabled check and a handler", () => {
  assert.deepEqual(commandRegistry.map((command) => command.name), ["wait-for-merge", "cherry-pick", "release", "team"]);
  for (const command of commandRegistry) {
    assert.equal(typeof command.isEnabled, "function");
    assert.equal(typeof command.run, "function");
    assert.equal(typeof command.pullRequestsOnly, "boolean");
    assert.equal(typeof command.handlesEditsAndDeletes, "boolean");
  }
});

test("command settings moved out of the Label Test config and commandDelivery is gone", () => {
  assert.throws(() => validateLabelTestWorkflowConfig({ waitForMerge: {} }), /moved to config\/commands\.jsonc/);
  assert.throws(() => validateLabelTestWorkflowConfig({ commandDelivery: "dispatch" }), /"commandDelivery" was removed/);
  assert.throws(() => validateCommandsConfig({ waitformerge: {} }, { labelTestWorkflowConfig: {} }), /unknown field "waitformerge"/);
  assert.deepEqual(validateCommandsConfig({}, { labelTestWorkflowConfig: {} }), {
    waitForMerge: null,
    cherryPick: null,
    release: null,
    team: null,
  });
});

test("a dispatched /wait-for-merge runs as before", async () => {
  const github = createGithub({ comments: [comment(1, "Alice", "/wait-for-merge Org/lib#42")] });

  const result = await run(github);

  assert.equal(result.handled, true);
  assert.equal(result.results["wait-for-merge"].labelAdded, true);
  assert.deepEqual(github.state.labels.map((label) => label.name), [LABEL]);
  assert.match(github.state.comments.at(-1).body, /Org\/lib#42: open \(requested by Alice\)/);
});

test("nothing runs when no command is enabled", async () => {
  const github = createGithub({ comments: [comment(1, "Alice", "/wait-for-merge Org/lib#42")] });

  const result = await run(github, { config: makeConfig({}) });

  assert.equal(result.reason, "disabled");
  assert.deepEqual(github.writes, []);
});

test("a dispatch is checked against the API instead of trusting its payload", async () => {
  const github = createGithub({
    comments: [
      comment(1, "Alice", "/wait-for-merge Org/lib#42", { issue: "Org/repo/issues/6" }),
      comment(2, "dependabot[bot]", "/wait-for-merge Org/lib#42", { type: "Bot" }),
      comment(3, "Alice", "thanks! /wait-for-merge Org/lib#42"),
    ],
  });

  assert.equal((await run(github, { repository: "Elsewhere/repo" })).reason, "organization");
  assert.equal((await run(github, { commentId: "1" })).reason, "mismatch");
  assert.equal((await run(github, { commentId: "2" })).reason, "bot");
  assert.equal((await run(github, { commentId: "3" })).reason, "not-command");
  assert.equal((await run(github, { commentId: "99" })).reason, "missing");
  assert.deepEqual(github.writes, []);
});

test("unknown and disabled commands are ignored without a reaction", async () => {
  const github = createGithub({ comments: [comment(1, "Alice", "/foo bar\n/team add testers")] });

  const result = await run(github);

  assert.equal(result.reason, "not-command");
  assert.deepEqual(github.writes, []);
});

test("one comment can run several commands", async () => {
  const github = createGithub({ comments: [comment(1, "Alice", "/wait-for-merge Org/lib#42\n/team add testers")] });

  const result = await run(github, { config: makeConfig(allCommands) });

  assert.equal(result.results["wait-for-merge"].labelAdded, true);
  assert.deepEqual(result.results.team.applied.map((item) => item.description), ["add Alice to testers"]);
  assert.ok(github.state.teamMembers.has("Alice"));
  assert.deepEqual(github.state.reactions, ["1:+1"]);
});

test("pull request commands leave issues alone, but /team works on issues", async () => {
  const github = createGithub({
    comments: [comment(1, "Alice", "/wait-for-merge Org/lib#42\n/team add testers")],
    isPullRequest: false,
  });

  const result = await run(github, { config: makeConfig(allCommands) });

  assert.equal(result.results["wait-for-merge"], undefined);
  assert.ok(github.state.teamMembers.has("Alice"));
  assert.deepEqual(github.state.labels, []);
});

test("edits and deletions only reach commands that keep state in comments", async () => {
  const github = createGithub({ comments: [comment(1, "Alice", "/team add testers")] });
  const config = makeConfig({ team: allCommands.team });

  assert.equal((await run(github, { config, commentAction: "edited" })).reason, "not-command");
  assert.equal((await run(github, { config, commentAction: "deleted" })).reason, "not-command");
  assert.deepEqual(github.writes, []);

  // With wait-for-merge on, an edit is reconciled even though the comment holds no wait-for-merge command.
  const both = await run(github, { config: makeConfig(allCommands), commentAction: "edited" });
  assert.equal(both.handled, true);
  assert.deepEqual(Object.keys(both.results), ["wait-for-merge"]);
  assert.equal(github.state.teamMembers.size, 0);
});

test("a failing command does not stop the others, and the run still fails", async () => {
  const github = createGithub({ comments: [comment(1, "Alice", "/wait-for-merge Org/lib#42\n/team add testers")] });
  const registry = [
    { name: "wait-for-merge", isEnabled: () => true, pullRequestsOnly: true, handlesEditsAndDeletes: true, run: async () => { throw new Error("boom"); } },
    { name: "team", isEnabled: () => true, pullRequestsOnly: false, handlesEditsAndDeletes: false, run: async () => "ran" },
  ];
  const lines = [];

  await assert.rejects(run(github, { registry, log: (line) => lines.push(line) }), /\/wait-for-merge: boom/);
  assert.ok(lines.some((line) => line.includes("::error title=/wait-for-merge failed::boom")));
});

test("a dispatch needs well-formed values", async () => {
  const github = createGithub({ comments: [comment(1, "Alice", "/wait-for-merge Org/lib#42")] });

  await assert.rejects(run(github, { repository: "Org/repo; rm -rf" }), /TARGET_REPOSITORY/);
  await assert.rejects(run(github, { pullRequestNumber: "5abc" }), /PULL_REQUEST_NUMBER/);
  await assert.rejects(run(github, { commentId: "" }), /COMMENT_ID/);
  await assert.rejects(run(github, { commentAction: "opened" }), /COMMENT_ACTION/);
});

test("command workflows take payload values only through env and have no GITHUB_TOKEN fallback", async () => {
  const dispatch = await readFile(new URL("../.github/workflows/label-test-command-dispatch.yml", import.meta.url), "utf8");
  const merge = await readFile(new URL("../.github/workflows/merge-commands.yml", import.meta.url), "utf8");

  assert.match(dispatch, /repository_dispatch:\n\s+types:\n\s+- pull-request-comment\n\s+- issue-comment\n/);
  assert.doesNotMatch(dispatch, /COMMAND_SOURCE/);
  assert.match(merge, /repository_dispatch:\n\s+types:\n\s+- pull-request-closed\n/);
  assert.match(merge, /workflow_dispatch:/);

  for (const workflow of [dispatch, merge]) {
    assert.doesNotMatch(workflow, /GITHUB_TOKEN:/);
    assert.match(workflow, /^permissions:\n {2}contents: read\n\n/m);
    assert.doesNotMatch(workflow, /pull_request_target|ref: \$\{\{ github\.event/);

    // Payload and input values may only appear in env and the concurrency group, never inside a run script.
    for (const line of workflow.split("\n").filter((item) => /client_payload|inputs\./.test(item))) {
      assert.match(line, /^\s+(group|TARGET_REPOSITORY|PULL_REQUEST_NUMBER|COMMENT_ID|COMMENT_ACTION):|^#/, line);
    }
  }

  // The per-repository caller and its reusable workflow are gone.
  await assert.rejects(access(new URL("../.github/workflows/label-test-command.yml", import.meta.url)));
});
