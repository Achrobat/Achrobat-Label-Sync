import assert from "node:assert/strict";
import test from "node:test";

import { validateLabelTestWorkflowConfig } from "../scripts/lib/config-validation.mjs";
import {
  parsePullRequestReference,
  parseWaitForMergeCommands,
  planWaitForMerge,
  planWaitForMergeCancellation,
  trackingCommentStatus,
} from "../scripts/lib/wait-for-merge.mjs";
import { reconcileWaitForMerge } from "../scripts/lib/wait-for-merge-runner.mjs";

const LABEL = "Waiting on PR";
const config = validateLabelTestWorkflowConfig({
  failingLabels: [LABEL],
  waitForMerge: { label: LABEL, allowedUsers: "teams/maintainers, Alice" },
});
const BOT = "label-sync[bot]";

function comment(id, login, body, createdAt, type = "User") {
  return { id, body, created_at: createdAt, user: { login, type } };
}

function unlabeled(createdAt, actor = "Someone") {
  return { id: Date.parse(createdAt), event: "unlabeled", label: { name: LABEL }, actor: { login: actor }, created_at: createdAt };
}

function plan(overrides) {
  return planWaitForMerge({
    config,
    repository: "Org/repo",
    pullRequestNumber: 5,
    pullRequestAuthor: "Author",
    prLabels: [],
    comments: [],
    labelEvents: [],
    mode: "check",
    isAllowedRunner: async (login) => ["alice", "bob"].includes(login.toLowerCase()),
    isAutomationActor: async (login) => login === BOT,
    getPullRequestState: async () => "open",
    ...overrides,
  });
}

test("parseWaitForMergeCommands reads every command line of a comment that starts with a slash", () => {
  assert.deepEqual(parseWaitForMergeCommands("/wait-for-merge #12\n/WAIT-FOR-MERGE Org/other#3 extra\nthanks"), ["#12", "Org/other#3"]);
  assert.deepEqual(parseWaitForMergeCommands("/wait-for-merge"), [""]);
  assert.deepEqual(parseWaitForMergeCommands("please /wait-for-merge #12"), []);
  assert.deepEqual(parseWaitForMergeCommands("/wait-for-merged #12"), []);
  assert.deepEqual(parseWaitForMergeCommands(null), []);
});

test("parsePullRequestReference accepts URLs, owner/repo#n and #n", () => {
  assert.deepEqual(parsePullRequestReference("https://github.com/Org/lib/pull/42/files", "Org/repo"), { owner: "Org", repo: "lib", number: 42 });
  assert.deepEqual(parsePullRequestReference("<https://github.com/Org/lib/pull/42>", "Org/repo"), { owner: "Org", repo: "lib", number: 42 });
  assert.deepEqual(parsePullRequestReference("Org/lib#7", "Org/repo"), { owner: "Org", repo: "lib", number: 7 });
  assert.deepEqual(parsePullRequestReference("#9", "Org/repo"), { owner: "Org", repo: "repo", number: 9 });
  assert.ok(parsePullRequestReference("https://github.com/Org/lib/issues/42", "Org/repo").error);
  assert.ok(parsePullRequestReference("", "Org/repo").error);
  assert.ok(parsePullRequestReference("#0", "Org/repo").error);
});

test("waitForMerge config must be a failing label, not sticky, and list allowed users", () => {
  assert.equal(validateLabelTestWorkflowConfig({}).waitForMerge, null);
  assert.equal(validateLabelTestWorkflowConfig({ waitForMerge: {} }).waitForMerge, null);
  assert.equal(config.waitForMerge.allowExternalRepositories, false);
  assert.deepEqual(config.waitForMerge.allowedUsers.map((member) => member.value), ["teams/maintainers", "Alice"]);
  assert.throws(
    () => validateLabelTestWorkflowConfig({ waitForMerge: { label: LABEL, allowedUsers: "Alice" } }),
    /must also be listed in "failingLabels"/,
  );
  assert.throws(
    () => validateLabelTestWorkflowConfig({
      failingLabels: [LABEL],
      stickyLabels: [{ label: LABEL, remover: "Alice" }],
      waitForMerge: { label: LABEL, allowedUsers: "Alice" },
    }),
    /cannot also be a sticky label/,
  );
  assert.throws(
    () => validateLabelTestWorkflowConfig({ failingLabels: [LABEL], waitForMerge: { label: LABEL } }),
    /allowedUsers must be/,
  );
  assert.throws(
    () => validateLabelTestWorkflowConfig({ waitForMerge: { allowedUsers: "Alice" } }),
    /needs a "label"/,
  );
  assert.throws(
    () => validateLabelTestWorkflowConfig({ failingLabels: [LABEL], waitForMerge: { label: LABEL, allowedUsers: "Alice, alice" } }),
    /more than once/,
  );
  assert.throws(
    () => validateLabelTestWorkflowConfig({ failingLabels: [LABEL], waitForMerge: { label: LABEL, allowedUsers: "Alice", allowExternalRepositories: "yes" } }),
    /allowExternalRepositories must be true or false/,
  );
});

test("a command linking an open pull request adds the label and creates the tracking comment", async () => {
  const result = await plan({
    mode: "command",
    triggeringCommentId: 1,
    comments: [comment(1, "Alice", "/wait-for-merge https://github.com/Org/lib/pull/42", "2026-10-01T00:00:00Z")],
  });

  assert.equal(result.addLabel, true);
  assert.equal(result.removeLabel, null);
  assert.match(result.createTracking.body, /^\*\*Wait for merge\*\* · ⏳ Waiting on 1 pull request\n/);
  assert.match(result.createTracking.body, /Org\/lib#42: open \(requested by Alice\)/);
  assert.doesNotMatch(result.createTracking.body, /@/);
  assert.doesNotMatch(result.createTracking.body, /\/wait-for-merge/);
});

test("commands stack, and the tracking comment is edited instead of a new one being posted", async () => {
  const states = { "Org/lib#42": "merged", "Org/lib#43": "open" };
  const firstBody = (await plan({
    mode: "command",
    triggeringCommentId: 1,
    comments: [comment(1, "Alice", "/wait-for-merge Org/lib#42", "2026-10-01T00:00:00Z")],
    getPullRequestState: async () => "open",
  })).createTracking.body;
  const result = await plan({
    mode: "command",
    triggeringCommentId: 3,
    prLabels: [{ name: LABEL }],
    comments: [
      comment(1, "Alice", "/wait-for-merge Org/lib#42", "2026-10-01T00:00:00Z"),
      comment(2, BOT, firstBody, "2026-10-01T00:00:05Z", "Bot"),
      comment(3, "Bob", "/wait-for-merge Org/lib#43", "2026-10-01T00:01:00Z"),
    ],
    getPullRequestState: async (reference) => states[`${reference.owner}/${reference.repo}#${reference.number}`],
  });

  assert.equal(result.addLabel, false);
  assert.equal(result.createTracking, null);
  assert.equal(result.updateTracking.commentId, 2);
  assert.match(result.updateTracking.body, /⏳ Waiting on 1 pull request/);
  assert.match(result.updateTracking.body, /✅ Org\/lib#42: merged/);
  assert.match(result.updateTracking.body, /⏳ Org\/lib#43: open \(requested by Bob\)/);
  assert.equal(result.readyToMergeComment, null);
});

test("a pull request closed without merging is noted by an edit while another is still open", async () => {
  const states = { "Org/lib#42": "closed", "Org/lib#43": "open" };
  const result = await plan({
    prLabels: [{ name: LABEL }],
    comments: [
      comment(1, "Alice", "/wait-for-merge Org/lib#42\n/wait-for-merge Org/lib#43", "2026-10-01T00:00:00Z"),
      comment(2, BOT, "**Wait for merge** · ⏳ Waiting on 2 pull requests\n\nold", "2026-10-01T00:00:05Z", "Bot"),
    ],
    getPullRequestState: async (reference) => states[`${reference.owner}/${reference.repo}#${reference.number}`],
  });

  assert.equal(result.removeLabel, null);
  assert.equal(result.readyToMergeComment, null);
  assert.match(result.updateTracking.body, /⚠️ Org\/lib#42: closed without merging/);
  assert.match(result.updateTracking.body, /Waiting on 1 pull request/);
});

test("the wait completes with one ready-to-merge comment pinging the author and every runner", async () => {
  const states = { "Org/lib#42": "merged", "Org/lib#43": "closed" };
  const result = await plan({
    prLabels: [{ name: "waiting on pr" }],
    comments: [
      comment(1, "Alice", "/wait-for-merge Org/lib#42", "2026-10-01T00:00:00Z"),
      comment(2, BOT, "**Wait for merge** · ⏳ Waiting on 2 pull requests\n\nold", "2026-10-01T00:00:05Z", "Bot"),
      comment(3, "Bob", "/wait-for-merge Org/lib#43", "2026-10-01T00:01:00Z"),
    ],
    getPullRequestState: async (reference) => states[`${reference.owner}/${reference.repo}#${reference.number}`],
  });

  assert.equal(result.removeLabel, "waiting on pr");
  assert.match(result.readyToMergeComment.body, /^@Author @Alice @Bob This pull request is ready to merge/);
  assert.match(result.readyToMergeComment.body, /Org\/lib#42 was merged/);
  assert.match(result.readyToMergeComment.body, /Org\/lib#43 was closed without merging/);
  assert.match(result.updateTracking.body, /^\*\*Wait for merge\*\* · ✅ Done/);
});

test("a ready-to-merge comment already posted in this wait is not posted again", async () => {
  const result = await plan({
    prLabels: [{ name: LABEL }],
    comments: [
      comment(1, "Alice", "/wait-for-merge Org/lib#42", "2026-10-01T00:00:00Z"),
      comment(2, BOT, "@Author This pull request is ready to merge: ...", "2026-10-01T00:05:00Z", "Bot"),
    ],
    getPullRequestState: async () => "merged",
  });

  assert.equal(result.removeLabel, LABEL);
  assert.equal(result.readyToMergeComment, null);
});

test("removing the label ends the wait: earlier commands no longer count", async () => {
  const result = await plan({
    prLabels: [{ name: LABEL }],
    labelEvents: [unlabeled("2026-10-02T00:00:00Z")],
    comments: [comment(1, "Alice", "/wait-for-merge Org/lib#42", "2026-10-01T00:00:00Z")],
    getPullRequestState: async () => "merged",
  });

  assert.equal(result.removeLabel, null);
  assert.equal(result.readyToMergeComment, null);
  assert.deepEqual(result.dependencies, []);
});

test("check mode never adds the label, and a label added by hand without a command is left alone", async () => {
  const withoutLabel = await plan({
    comments: [comment(1, "Alice", "/wait-for-merge Org/lib#42", "2026-10-01T00:00:00Z")],
  });
  assert.equal(withoutLabel.addLabel, false);
  assert.equal(withoutLabel.createTracking, null);

  const manual = await plan({ prLabels: [{ name: LABEL }], getPullRequestState: async () => "merged" });
  assert.equal(manual.removeLabel, null);
});

test("unreadable pull requests keep the wait going", async () => {
  const result = await plan({
    prLabels: [{ name: LABEL }],
    comments: [comment(1, "Alice", "/wait-for-merge Org/private#1", "2026-10-01T00:00:00Z")],
    getPullRequestState: async () => "unreadable",
  });

  assert.equal(result.removeLabel, null);
});

test("invalid, self and outside-organization links are listed as ignored and add no label", async () => {
  const result = await plan({
    mode: "command",
    triggeringCommentId: 1,
    comments: [comment(1, "Alice", "/wait-for-merge Org/repo#5\n/wait-for-merge Other/lib#1\n/wait-for-merge @everyone`x`", "2026-10-01T00:00:00Z")],
  });

  assert.equal(result.addLabel, false);
  assert.match(result.createTracking.body, /💤 Not waiting/);
  assert.match(result.createTracking.body, /`Org\/repo#5`: links to this pull request/);
  assert.match(result.createTracking.body, /`Other\/lib#1`: is outside this organization/);
  assert.match(result.createTracking.body, /`@everyonex`: not a pull request link/);

  const external = await planWaitForMerge({
    config: { waitForMerge: { ...config.waitForMerge, allowExternalRepositories: true } },
    repository: "Org/repo",
    pullRequestNumber: 5,
    prLabels: [],
    comments: [comment(1, "Alice", "/wait-for-merge Other/lib#1", "2026-10-01T00:00:00Z")],
    labelEvents: [],
    mode: "command",
    triggeringCommentId: 1,
    isAllowedRunner: async () => true,
    isAutomationActor: async () => false,
    getPullRequestState: async () => "open",
  });
  assert.equal(external.addLabel, true);
});

test("commands from people who are not allowed, or from bots, are ignored", async () => {
  const notAllowed = await plan({
    mode: "command",
    triggeringCommentId: 1,
    comments: [comment(1, "Mallory", "/wait-for-merge Org/lib#42", "2026-10-01T00:00:00Z")],
  });
  assert.deepEqual(notAllowed.triggerRejected, { reason: "not-allowed", login: "Mallory" });
  assert.equal(notAllowed.addLabel, false);

  const bot = await plan({
    mode: "command",
    triggeringCommentId: 1,
    isAllowedRunner: async () => true,
    comments: [comment(1, "helper[bot]", "/wait-for-merge Org/lib#42", "2026-10-01T00:00:00Z", "Bot")],
  });
  assert.equal(bot.addLabel, false);
  assert.equal(bot.createTracking, null);
});

test("a tracking comment that looks right but was not written by Label Sync is ignored", async () => {
  const result = await plan({
    mode: "command",
    triggeringCommentId: 1,
    comments: [
      comment(9, "Mallory", "**Wait for merge** · ⏳ Waiting on 1 pull request", "2026-09-30T00:00:00Z"),
      comment(1, "Alice", "/wait-for-merge Org/lib#42", "2026-10-01T00:00:00Z"),
    ],
  });
  assert.ok(result.createTracking);
  assert.equal(result.updateTracking, null);
});

test("removing the label by hand rewrites an active tracking comment as cancelled", async () => {
  const tracking = comment(2, BOT, "**Wait for merge** · ⏳ Waiting on 1 pull request\n\n- ⏳ Org/lib#42: open (requested by Alice)\n\nfooter", "2026-10-01T00:00:05Z", "Bot");
  const cancellation = await planWaitForMergeCancellation({
    config,
    comments: [tracking],
    triggeringEvent: { action: "unlabeled", label: LABEL, sender: "Bob" },
    isAutomationActor: async (login) => login === BOT,
  });

  assert.equal(cancellation.commentId, 2);
  assert.equal(trackingCommentStatus(cancellation.body), "cancelled");
  assert.match(cancellation.body, /- ⏳ Org\/lib#42: open/);
  assert.match(cancellation.body, /removed by Bob, so this wait was cancelled/);

  assert.equal(await planWaitForMergeCancellation({
    config,
    comments: [tracking],
    triggeringEvent: { action: "unlabeled", label: LABEL, sender: BOT },
    isAutomationActor: async (login) => login === BOT,
  }), null);
  assert.equal(await planWaitForMergeCancellation({
    config,
    comments: [{ ...tracking, body: "**Wait for merge** · ✅ Done\n\nx\n\ny" }],
    triggeringEvent: { action: "unlabeled", label: LABEL, sender: "Bob" },
    isAutomationActor: async (login) => login === BOT,
  }), null);
});

// End-to-end against an in-memory GitHub, through the same runner the workflows use.
function createFakeGithub({ labels = [], comments = [], events = [], pulls = {} }) {
  const state = { labels: [...labels], comments: [...comments], events: [...events], calls: [], nextId: 100 };
  const request = async (method, apiPath, body) => {
    state.calls.push(`${method} ${apiPath.replace(/\?.*$/, "")}`);
    const pathOnly = apiPath.replace(/\?.*$/, "");
    const page = Number(/[?&]page=(\d+)/.exec(apiPath)?.[1] ?? 1);
    let match;

    if (method === "GET" && pathOnly === "/repos/Org/repo/issues/5") {
      return { number: 5, state: "open", pull_request: {}, user: { login: "Author" }, labels: state.labels };
    }
    if (method === "GET" && pathOnly === "/repos/Org/repo/issues/5/comments") {
      return page === 1 ? state.comments : [];
    }
    if (method === "GET" && pathOnly === "/repos/Org/repo/issues/5/events") {
      return page === 1 ? state.events : [];
    }
    if (method === "POST" && pathOnly === "/repos/Org/repo/issues/5/comments") {
      state.comments.push(comment(state.nextId++, BOT, body.body, new Date(Date.UTC(2026, 9, 3, 0, state.nextId)).toISOString(), "Bot"));
      return {};
    }
    if (method === "PATCH" && (match = /^\/repos\/Org\/repo\/issues\/comments\/(\d+)$/.exec(pathOnly))) {
      state.comments.find((item) => String(item.id) === match[1]).body = body.body;
      return {};
    }
    if (method === "POST" && pathOnly === "/repos/Org/repo/issues/5/labels") {
      state.labels.push(...body.labels.map((name) => ({ name })));
      return state.labels;
    }
    if (method === "DELETE" && (match = /^\/repos\/Org\/repo\/issues\/5\/labels\/(.+)$/.exec(pathOnly))) {
      const name = decodeURIComponent(match[1]);
      state.labels = state.labels.filter((label) => label.name !== name);
      return state.labels;
    }
    if (method === "POST" && /\/reactions$/.test(pathOnly)) {
      return {};
    }
    if (method === "GET" && (match = /^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)$/.exec(pathOnly))) {
      const pull = pulls[`${match[1]}/${match[2]}#${match[3]}`];
      if (!pull) {
        const error = new Error("Not Found");
        error.status = 404;
        throw error;
      }
      return pull;
    }
    throw new Error(`Unexpected ${method} ${apiPath}`);
  };
  return { state, request };
}

async function runReconcile(fake, options) {
  return reconcileWaitForMerge({
    request: fake.request,
    config,
    repository: "Org/repo",
    pullRequestNumber: 5,
    isTeamMember: async () => false,
    isAutomationActor: async (login) => login === BOT,
    log: () => {},
    ...options,
  });
}

test("end to end: command, partial merge, completion", async () => {
  const pulls = { "Org/lib#42": { state: "open" }, "Org/lib#43": { state: "open" } };
  const fake = createFakeGithub({
    comments: [comment(1, "Alice", "/wait-for-merge Org/lib#42\n/wait-for-merge #7\n/wait-for-merge Org/lib#43", "2026-10-01T00:00:00Z")],
    pulls: { ...pulls, "Org/repo#7": { state: "closed", merged_at: "2026-09-01T00:00:00Z" } },
  });

  const started = await runReconcile(fake, { mode: "command", triggeringCommentId: 1 });
  assert.equal(started.labelAdded, true);
  assert.deepEqual(fake.state.labels.map((label) => label.name), [LABEL]);
  assert.equal(fake.state.comments.length, 2);
  assert.match(fake.state.comments[1].body, /Waiting on 2 pull requests/);

  Object.assign(pulls["Org/lib#42"], { state: "closed", merged_at: "2026-10-02T00:00:00Z" });
  const partial = await runReconcile(fake, { mode: "check" });
  assert.equal(partial.labelRemoved, false);
  assert.equal(fake.state.comments.length, 2, "a partial merge edits the tracking comment");
  assert.match(fake.state.comments[1].body, /Waiting on 1 pull request\n/);
  assert.match(fake.state.comments[1].body, /✅ Org\/lib#42: merged/);

  // Calling the API with the same state again changes nothing.
  const callsBefore = fake.state.calls.filter((call) => !call.startsWith("GET")).length;
  await runReconcile(fake, { mode: "check" });
  assert.equal(fake.state.calls.filter((call) => !call.startsWith("GET")).length, callsBefore);
});

test("end to end: the last open pull request closing completes the wait once", async () => {
  const pulls = { "Org/lib#42": { state: "closed", merged_at: "2026-10-02T00:00:00Z" } };
  const fake = createFakeGithub({
    labels: [{ name: LABEL }],
    comments: [comment(1, "Alice", "/wait-for-merge Org/lib#42", "2026-10-01T00:00:00Z")],
    events: [{ id: 1, event: "labeled", label: { name: LABEL }, created_at: "2026-10-01T00:00:03Z" }],
    pulls,
  });

  const done = await runReconcile(fake, { mode: "check" });
  assert.equal(done.labelRemoved, true);
  assert.deepEqual(fake.state.labels, []);
  assert.equal(fake.state.comments.filter((item) => /ready to merge/.test(item.body)).length, 1);

  const again = await runReconcile(fake, { mode: "check" });
  assert.equal(again.labelRemoved, false);
  assert.equal(fake.state.comments.filter((item) => /ready to merge/.test(item.body)).length, 1);
});

test("end to end: a command from someone not allowed only gets a reaction", async () => {
  const fake = createFakeGithub({
    comments: [comment(1, "Mallory", "/wait-for-merge Org/lib#42", "2026-10-01T00:00:00Z")],
    pulls: { "Org/lib#42": { state: "open" } },
  });

  const outcome = await runReconcile(fake, { mode: "command", triggeringCommentId: 1 });
  assert.equal(outcome.labelAdded, false);
  assert.deepEqual(fake.state.calls.filter((call) => !call.startsWith("GET")), [
    "POST /repos/Org/repo/issues/comments/1/reactions",
  ]);
});
