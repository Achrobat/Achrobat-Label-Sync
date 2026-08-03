import assert from "node:assert/strict";
import test from "node:test";

import {
  generateCallerWorkflow,
  generateCallerWorkflows,
  normalizeDeliveryMode,
  parseTargetRepositories,
  preflightDistributionRepository,
  processDistributionRepositories,
  renderDistributionSummaryMarkdown,
  selectDistributionRepositories,
  writeCallerWorkflows,
} from "../scripts/distribute-label-test-workflows.mjs";

const repositories = [
  { name: "alpha", full_name: "example/alpha", archived: false, permissions: { push: true } },
  { name: "beta", full_name: "example/beta", archived: false, permissions: { push: true } },
  { name: "gamma", full_name: "example/gamma", archived: false, permissions: { push: true } },
  { name: "label-sync", full_name: "example/label-sync", archived: false, permissions: { push: true } },
];

function encodeContent(value) {
  return value === null ? null : Buffer.from(value, "utf8").toString("base64");
}

const updateBranch = "label-sync/update-label-test-workflow";
const legacyWorkflowPath = ".github/workflows/label-test-review-signal.yml";

const workflowSet = [
  { path: ".github/workflows/label-test.yml", content: "policy" },
  { path: ".github/workflows/label-test-review-refresh.yml", content: "signal" },
];

const currentWorkflowFiles = {
  ".github/workflows/label-test.yml": "policy",
  ".github/workflows/label-test-review-refresh.yml": "signal",
};

function createFakeDistributionApi({
  files = {},
  updateBranchExists = true,
  pullRequest = null,
} = {}) {
  const calls = [];
  const api = {
    async getDefaultBranch(token, repository) {
      calls.push({ operation: "getDefaultBranch", repository });
      return "main";
    },
    async getBranchRef(token, repository, branch) {
      calls.push({ operation: "getBranchRef", repository, branch });

      if (branch === "main") {
        return { object: { sha: "default-sha" } };
      }

      return updateBranchExists ? { object: { sha: "update-sha" } } : null;
    },
    async createBranchRef(token, repository, branch, sha) {
      calls.push({ operation: "createBranchRef", repository, branch, sha });
      return { object: { sha } };
    },
    async getFileContent(token, repository, filePath, ref) {
      calls.push({ operation: "getFileContent", repository, filePath, ref });
      const value = files[ref]?.[filePath];
      return value === undefined
        ? null
        : { content: encodeContent(value), sha: `${ref}-file-sha` };
    },
    async createCommitOnBranch(token, repository, options) {
      calls.push({ operation: "createCommitOnBranch", repository, options });
      return { oid: "commit-oid", url: `https://github.com/${repository}/commit/commit-oid` };
    },
    async getOpenUpdatePullRequest(token, repository, owner, branch) {
      calls.push({ operation: "getOpenUpdatePullRequest", repository, owner, branch });
      return pullRequest;
    },
    async createUpdatePullRequest(token, repository, options) {
      calls.push({ operation: "createUpdatePullRequest", repository, options });
      return { number: 42, html_url: `https://github.com/${repository}/pull/42` };
    },
  };

  return { api, calls };
}

function countCalls(calls, operation) {
  return calls.filter((call) => call.operation === operation).length;
}

function findCommit(calls) {
  return calls.find((call) => call.operation === "createCommitOnBranch");
}

function distributionOptions(api, overrides = {}) {
  return {
    workflows: workflowSet,
    deliveryMode: "direct_commit",
    dryRun: false,
    defaultBranch: "main",
    defaultRef: { object: { sha: "default-sha" } },
    api,
    ...overrides,
  };
}

test("writeCallerWorkflows delivers every generated workflow in a single commit", async () => {
  const { api, calls } = createFakeDistributionApi({ files: {} });

  const result = await writeCallerWorkflows(
    "token",
    { full_name: "example/alpha" },
    distributionOptions(api),
  );

  assert.equal(countCalls(calls, "createCommitOnBranch"), 1);

  const commit = findCommit(calls);
  assert.deepEqual(
    commit.options.additions.map((addition) => addition.path),
    workflowSet.map((workflow) => workflow.path),
  );
  assert.deepEqual(commit.options.deletions, []);
  assert.equal(commit.options.branch, "main");
  assert.equal(commit.options.expectedHeadOid, "default-sha");
  assert.equal(result.status, "created");
  assert.equal(result.branch, "main");
});

test("writeCallerWorkflows folds the obsolete workflow deletion into the same commit", async () => {
  const { api, calls } = createFakeDistributionApi({
    files: { main: { [legacyWorkflowPath]: "obsolete" } },
  });

  const result = await writeCallerWorkflows(
    "token",
    { full_name: "example/alpha" },
    distributionOptions(api),
  );

  assert.equal(countCalls(calls, "createCommitOnBranch"), 1);

  const commit = findCommit(calls);
  assert.equal(commit.options.additions.length, 2);
  assert.deepEqual(commit.options.deletions, [legacyWorkflowPath]);
  assert.equal(result.status, "created");
});

test("writeCallerWorkflows only commits the workflows that actually changed", async () => {
  const { api, calls } = createFakeDistributionApi({
    files: { main: { ".github/workflows/label-test.yml": "policy" } },
  });

  const result = await writeCallerWorkflows(
    "token",
    { full_name: "example/alpha" },
    distributionOptions(api),
  );

  const commit = findCommit(calls);
  assert.deepEqual(
    commit.options.additions.map((addition) => addition.path),
    [".github/workflows/label-test-review-refresh.yml"],
  );
  assert.equal(result.status, "updated");
});

test("writeCallerWorkflows reuses an existing update branch instead of creating one", async () => {
  const { api, calls } = createFakeDistributionApi({ updateBranchExists: true, files: {} });

  const result = await writeCallerWorkflows(
    "token",
    { full_name: "example/alpha" },
    distributionOptions(api, { deliveryMode: "open_pr" }),
  );

  assert.equal(countCalls(calls, "createBranchRef"), 0);
  assert.equal(countCalls(calls, "createCommitOnBranch"), 1);

  const commit = findCommit(calls);
  assert.equal(commit.options.branch, updateBranch);
  assert.equal(commit.options.expectedHeadOid, "update-sha");
  assert.equal(result.branch, updateBranch);
  assert.equal(result.pullRequest.number, 42);
});

test("writeCallerWorkflows creates the update branch when it is missing", async () => {
  const { api, calls } = createFakeDistributionApi({ updateBranchExists: false, files: {} });

  const result = await writeCallerWorkflows(
    "token",
    { full_name: "example/alpha" },
    distributionOptions(api, { deliveryMode: "open_pr" }),
  );

  assert.equal(countCalls(calls, "createBranchRef"), 1);
  assert.equal(countCalls(calls, "createCommitOnBranch"), 1);

  const commit = findCommit(calls);
  assert.equal(commit.options.branch, updateBranch);
  assert.equal(commit.options.expectedHeadOid, "default-sha");
  assert.equal(result.status, "created");
});

test("writeCallerWorkflows reports unchanged without committing", async () => {
  const { api, calls } = createFakeDistributionApi({
    updateBranchExists: false,
    files: { main: currentWorkflowFiles },
  });

  const result = await writeCallerWorkflows(
    "token",
    { full_name: "example/alpha" },
    distributionOptions(api),
  );

  assert.equal(countCalls(calls, "createCommitOnBranch"), 0);
  assert.equal(result.status, "unchanged");
  assert.equal(result.branch, "main");
});

test("writeCallerWorkflows opens a missing pull request when the update branch already carries the change", async () => {
  const { api, calls } = createFakeDistributionApi({
    updateBranchExists: true,
    files: { [updateBranch]: currentWorkflowFiles, main: {} },
  });

  const result = await writeCallerWorkflows(
    "token",
    { full_name: "example/alpha" },
    distributionOptions(api, { deliveryMode: "open_pr" }),
  );

  assert.equal(countCalls(calls, "createCommitOnBranch"), 0);
  assert.equal(result.status, "unchanged");
  assert.equal(result.pullRequest.number, 42);
});

test("writeCallerWorkflows does not reopen a pull request when the default branch is current", async () => {
  const { api, calls } = createFakeDistributionApi({
    updateBranchExists: true,
    files: { [updateBranch]: currentWorkflowFiles, main: currentWorkflowFiles },
  });

  const result = await writeCallerWorkflows(
    "token",
    { full_name: "example/alpha" },
    distributionOptions(api, { deliveryMode: "open_pr" }),
  );

  assert.equal(countCalls(calls, "createUpdatePullRequest"), 0);
  assert.equal(result.status, "unchanged");
  assert.equal(result.pullRequest, undefined);
});

test("writeCallerWorkflows dry-run mode performs no mutations", async () => {
  const { api, calls } = createFakeDistributionApi({ updateBranchExists: false, files: {} });

  const result = await writeCallerWorkflows(
    "token",
    { full_name: "example/alpha" },
    distributionOptions(api, { deliveryMode: "open_pr", dryRun: true }),
  );

  assert.equal(countCalls(calls, "createCommitOnBranch"), 0);
  assert.equal(countCalls(calls, "createBranchRef"), 0);
  assert.equal(countCalls(calls, "createUpdatePullRequest"), 0);
  assert.equal(result.status, "would_create");
  assert.equal(result.branch, updateBranch);
});

test("writeCallerWorkflows dry-run reports an update when an existing workflow differs", async () => {
  const { api, calls } = createFakeDistributionApi({
    files: { main: { ".github/workflows/label-test.yml": "stale" } },
  });

  const result = await writeCallerWorkflows(
    "token",
    { full_name: "example/alpha" },
    distributionOptions(api, { dryRun: true }),
  );

  assert.equal(countCalls(calls, "createCommitOnBranch"), 0);
  assert.equal(result.status, "would_update");
});

test("writeCallerWorkflows identifies the workflow-file stage on commit failure", async () => {
  const { api } = createFakeDistributionApi({ files: {} });
  api.createCommitOnBranch = async () => {
    throw new Error("commit rejected");
  };

  await assert.rejects(
    () => writeCallerWorkflows(
      "token",
      { full_name: "example/alpha" },
      distributionOptions(api),
    ),
    (error) => {
      assert.equal(error.stage, "workflow_file");
      assert.match(error.message, /commit rejected/);
      return true;
    },
  );
});

test("processDistributionRepositories skips an empty repository and continues", async () => {
  const processed = [];
  const api = {
    async getDefaultBranch(token, repository) {
      return "main";
    },
    async getBranchRef(token, repository, branch) {
      return repository === "example/empty" ? null : { object: { sha: `${repository}-sha` } };
    },
  };

  const outcome = await processDistributionRepositories([
    { full_name: "example/empty" },
    { full_name: "example/ready" },
  ], {
    token: "token",
    deliveryMode: "open_pr",
    content: "name: Generated workflow\n",
    dryRun: false,
    api,
    write: async (token, repository) => {
      processed.push(repository.full_name);
      return {
        repository: repository.full_name,
        status: "created",
        branch: "label-sync/update-label-test-workflow",
      };
    },
  });

  assert.deepEqual(processed, ["example/ready"]);
  assert.deepEqual(outcome.skippedRepositories, [
    { repository: "example/empty", reason: "empty" },
  ]);
  assert.deepEqual(outcome.results.map((result) => result.repository), ["example/ready"]);
  assert.equal(outcome.processingError, null);
});

test("processDistributionRepositories forwards the generated workflow set to its writer", async () => {
  const workflows = [
    { path: ".github/workflows/label-test.yml", content: "policy" },
    { path: ".github/workflows/label-test-review-refresh.yml", content: "signal" },
  ];
  let receivedWorkflows;

  await processDistributionRepositories([
    { full_name: "example/ready" },
  ], {
    token: "token",
    deliveryMode: "direct_commit",
    workflows,
    dryRun: false,
    preflight: async () => ({
      defaultBranch: "main",
      defaultRef: { object: { sha: "default-sha" } },
    }),
    write: async (token, repository, options) => {
      receivedWorkflows = options.workflows;
      return {
        repository: repository.full_name,
        status: "updated",
        branch: "main",
      };
    },
  });

  assert.deepEqual(receivedWorkflows, workflows);
});

test("preflightDistributionRepository blocks direct commits to a protected default branch", async () => {
  const calls = [];
  const api = {
    async getDefaultBranch() {
      return "main";
    },
    async getBranchRef() {
      return { object: { sha: "default-sha" } };
    },
    async getBranch(token, repository, branch) {
      calls.push({ repository, branch });
      return { name: branch, protected: true };
    },
  };

  const state = await preflightDistributionRepository("token", { full_name: "example/alpha" }, {
    api,
    deliveryMode: "direct_commit",
  });

  assert.deepEqual(calls, [{ repository: "example/alpha", branch: "main" }]);
  assert.match(state.blockedReason, /protected/);
  assert.match(state.blockedReason, /Pull Request mode/);
  assert.equal(state.defaultBranch, undefined);
});

test("preflightDistributionRepository does not check protection in pull request mode", async () => {
  let checkedProtection = false;
  const api = {
    async getDefaultBranch() {
      return "main";
    },
    async getBranchRef() {
      return { object: { sha: "default-sha" } };
    },
    async getBranch() {
      checkedProtection = true;
      return { protected: true };
    },
  };

  const state = await preflightDistributionRepository("token", { full_name: "example/alpha" }, {
    api,
    deliveryMode: "open_pr",
  });

  assert.equal(checkedProtection, false);
  assert.equal(state.blockedReason, undefined);
  assert.equal(state.defaultBranch, "main");
});

test("processDistributionRepositories records a blocked repository and keeps going", async () => {
  const processed = [];
  const preflight = async (token, repository) => (
    repository.full_name === "example/protected"
      ? { blockedReason: 'Default branch "main" is protected, so Direct Commit cannot write to it.' }
      : { defaultBranch: "main", defaultRef: { object: { sha: "default-sha" } } }
  );

  const outcome = await processDistributionRepositories([
    { full_name: "example/protected" },
    { full_name: "example/ready" },
  ], {
    token: "token",
    deliveryMode: "direct_commit",
    workflows: [],
    dryRun: false,
    preflight,
    write: async (token, repository) => {
      processed.push(repository.full_name);
      return { repository: repository.full_name, status: "created", branch: "main" };
    },
  });

  // The blocked repository must not halt the run the way an unexpected API error does.
  assert.deepEqual(processed, ["example/ready"]);
  assert.deepEqual(
    outcome.results.map((result) => [result.repository, result.status]),
    [["example/protected", "failed"], ["example/ready", "created"]],
  );
  assert.equal(outcome.results[0].stage, "preflight");
  assert.match(outcome.results[0].error, /protected/);
  assert.equal(outcome.skippedRepositories.length, 0);
  // Still reported as a failure overall so the run ends red.
  assert.match(outcome.processingError.message, /protected/);
  assert.ok(outcome.results.every((result) => result.status !== "not_processed"));
});

test("dry run reports a protected repository instead of claiming it would be written", async () => {
  const mutations = [];
  const api = {
    async getDefaultBranch() {
      return "main";
    },
    async getBranchRef() {
      return { object: { sha: "default-sha" } };
    },
    async getBranch() {
      return { protected: true };
    },
    async getFileContent() {
      return null;
    },
    async createBranchRef(token, repository) {
      mutations.push({ operation: "createBranchRef", repository });
      return { object: { sha: "x" } };
    },
    async createCommitOnBranch(token, repository) {
      mutations.push({ operation: "createCommitOnBranch", repository });
      return { oid: "x" };
    },
    async createUpdatePullRequest(token, repository) {
      mutations.push({ operation: "createUpdatePullRequest", repository });
      return { number: 1 };
    },
  };

  const outcome = await processDistributionRepositories([
    { full_name: "example/protected" },
  ], {
    token: "token",
    deliveryMode: "direct_commit",
    workflows: workflowSet,
    dryRun: true,
    api,
  });

  // A dry run that reported "would create" for a repository it definitively cannot write
  // to would be worse than useless, so the block is surfaced during the preview too.
  assert.deepEqual(
    outcome.results.map((result) => [result.repository, result.status]),
    [["example/protected", "failed"]],
  );
  assert.match(outcome.results[0].error, /protected/);
  // Whatever it reports, a dry run must never write.
  assert.deepEqual(mutations, []);
});

test("processDistributionRepositories stops after the first unexpected failure", async () => {
  const processed = [];
  const failure = new Error("workflow file write rejected");
  failure.stage = "workflow_file";

  const outcome = await processDistributionRepositories([
    { full_name: "example/one" },
    { full_name: "example/two" },
    { full_name: "example/three" },
  ], {
    token: "token",
    deliveryMode: "open_pr",
    content: "name: Generated workflow\n",
    dryRun: false,
    preflight: async () => ({
      defaultBranch: "main",
      defaultRef: { object: { sha: "default-sha" } },
    }),
    write: async (token, repository) => {
      processed.push(repository.full_name);

      if (repository.full_name === "example/two") {
        throw failure;
      }

      return {
        repository: repository.full_name,
        status: "created",
        branch: "label-sync/update-label-test-workflow",
      };
    },
  });

  assert.deepEqual(processed, ["example/one", "example/two"]);
  assert.deepEqual(outcome.results, [
    {
      repository: "example/one",
      status: "created",
      branch: "label-sync/update-label-test-workflow",
    },
    {
      repository: "example/two",
      status: "failed",
      stage: "workflow_file",
      branch: "label-sync/update-label-test-workflow",
      error: "workflow file write rejected",
    },
    {
      repository: "example/three",
      status: "not_processed",
      branch: "label-sync/update-label-test-workflow",
      error: "Stopped after failure in example/two.",
    },
  ]);
  assert.equal(outcome.processingError, failure);
});

test("selectDistributionRepositories applies whitelist mode and skips the source repository", () => {
  const selected = selectDistributionRepositories(repositories, {
    orgName: "example",
    sourceRepository: "example/label-sync",
    mode: "whitelist",
    workflowDistribution: {
      whitelist: new Set(["alpha", "example/beta", "label-sync"]),
      blacklist: new Set([]),
    },
  });

  assert.deepEqual(selected.map((repository) => repository.full_name), [
    "example/alpha",
    "example/beta",
  ]);
});

test("selectDistributionRepositories applies blacklist mode", () => {
  const selected = selectDistributionRepositories(repositories, {
    orgName: "example",
    sourceRepository: "example/label-sync",
    mode: "blacklist",
    workflowDistribution: {
      whitelist: new Set([]),
      blacklist: new Set(["beta"]),
    },
  });

  assert.deepEqual(selected.map((repository) => repository.full_name), [
    "example/alpha",
    "example/gamma",
  ]);
});

test("selectDistributionRepositories lets target repository override take priority over mode", () => {
  const selected = selectDistributionRepositories(repositories, {
    orgName: "example",
    sourceRepository: "example/label-sync",
    mode: "blacklist",
    targetRepositories: new Set(["beta"]),
    workflowDistribution: {
      whitelist: new Set([]),
      blacklist: new Set(["beta", "gamma"]),
    },
  });

  assert.deepEqual(selected.map((repository) => repository.full_name), [
    "example/beta",
  ]);
});

test("parseTargetRepositories parses comma-separated repository override names", () => {
  assert.deepEqual(
    parseTargetRepositories("alpha, example/Beta, , gamma "),
    new Set(["alpha", "example/beta", "gamma"]),
  );
  assert.equal(parseTargetRepositories(""), null);
});

test("selectDistributionRepositories rejects unknown target repository overrides", () => {
  assert.throws(
    () => selectDistributionRepositories(repositories, {
      orgName: "example",
      sourceRepository: "example/label-sync",
      mode: "whitelist",
      targetRepositories: new Set(["missing-repo"]),
      workflowDistribution: {
        whitelist: new Set([]),
        blacklist: new Set([]),
      },
    }),
    /Requested repositories were not found in the discovered org repository set: missing-repo\./,
  );
});


test("generateCallerWorkflow calls the distributing repository reusable workflow", () => {
  const workflow = generateCallerWorkflow({
    sourceRepository: "fork-owner/Label-Sync",
    sourceRef: "main",
  });

  assert.match(workflow, /name: Label Test/);
  assert.match(workflow, /pull_request_target:/);
  assert.doesNotMatch(workflow, /pull_request_review:/);
  assert.match(workflow, /uses: fork-owner\/Label-Sync\/\.github\/workflows\/label-test\.yml@main/);
  assert.match(workflow, /label_sync_repository: fork-owner\/Label-Sync/);
  assert.match(workflow, /label_sync_ref: main/);
  // The repository and pull request are read from the caller's context inside the
  // reusable workflow, so they must not reappear as inputs here. Every input in this
  // file is a reason the distributed callers would need updating again later.
  assert.doesNotMatch(workflow, /target_repository:/);
  assert.doesNotMatch(workflow, /pull_request_number:/);
  assert.equal(workflow.match(/^ {6}label_sync_[a-z]+:/gm).length, 2);
});

test("generateCallerWorkflows emits one policy workflow and one review refresh workflow", () => {
  const workflows = generateCallerWorkflows({
    sourceRepository: "fork-owner/Label-Sync",
    sourceRef: "main",
  });
  const byPath = new Map(workflows.map((workflow) => [workflow.path, workflow.content]));

  assert.deepEqual([...byPath.keys()], [
    ".github/workflows/label-test.yml",
    ".github/workflows/label-test-review-refresh.yml",
  ]);

  const policy = byPath.get(".github/workflows/label-test.yml");
  assert.match(policy, /pull_request_target:/);
  assert.match(policy, /uses: fork-owner\/Label-Sync\/\.github\/workflows\/label-test\.yml@main/);
  assert.match(policy, /secrets: inherit/);
  // The policy workflow must publish exactly one check, so it carries a single job
  // and reacts to a single event. A second trigger would create a second check
  // suite, and a job-level `if` would publish a permanently skipped check.
  assert.doesNotMatch(policy, /workflow_run:/);
  assert.doesNotMatch(policy, /pull_request_review:/);
  assert.doesNotMatch(policy, /^\s*if:/m);
  assert.doesNotMatch(policy, /name: Refresh Label Test/);
  assert.doesNotMatch(policy, /actions:\s*write/);
  assert.equal(policy.match(/^ {2}[a-z0-9-]+:$/gm).length, 1);
  // Permission headroom: the caller caps what the reusable workflow can ever be granted,
  // so it is deliberately wider than what the reusable workflow uses today. An unused
  // permission costs nothing, and narrowing these would mean redistributing to every
  // target repository just to enable a new capability.
  assert.match(policy, /pull-requests: write/);
  assert.match(policy, /checks: write/);
  // Triggers get the opposite treatment. This workflow publishes a required check, so
  // every extra type costs a runner and a pending check on each occurrence. Events that
  // cannot change the label or approval verdict must stay out.
  assert.doesNotMatch(policy, /- edited/);
  assert.doesNotMatch(policy, /- converted_to_draft/);
  // Review state reaches this check through the refresh workflow, not directly, so
  // neither review request type belongs here.
  assert.doesNotMatch(policy, /- review_requested/);
  assert.doesNotMatch(policy, /- review_request_removed/);
  assert.deepEqual(policy.match(/^ {6}- [a-z_]+$/gm).map((line) => line.trim().slice(2)), [
    "opened",
    "synchronize",
    "reopened",
    "labeled",
    "unlabeled",
    "ready_for_review",
  ]);

  const refresh = byPath.get(".github/workflows/label-test-review-refresh.yml");
  assert.match(refresh, /name: Label Test Review Refresh/);
  assert.match(refresh, /pull_request_review:/);
  assert.match(refresh, /- submitted/);
  assert.match(refresh, /- edited/);
  assert.match(refresh, /- dismissed/);
  assert.match(refresh, /name: Refresh Label Test/);
  assert.match(refresh, /actions:\s*write/);
  assert.match(refresh, /uses: fork-owner\/Label-Sync\/\.github\/workflows\/refresh-label-test\.yml@main/);
  assert.match(refresh, /secrets: inherit/);
  assert.doesNotMatch(refresh, /target_repository:/);
  assert.doesNotMatch(refresh, /pull_request_number:/);
  // The artifact handshake is gone; the PR number comes straight from the event payload.
  assert.doesNotMatch(refresh, /upload-artifact/);
  assert.doesNotMatch(refresh, /label-test-review-context/);
  assert.doesNotMatch(refresh, /workflow_run:/);
});

test("normalizeDeliveryMode accepts workflow choice labels", () => {
  assert.equal(normalizeDeliveryMode("Direct Commit"), "direct_commit");
  assert.equal(normalizeDeliveryMode("Pull Request"), "open_pr");
  assert.equal(normalizeDeliveryMode("direct_commit"), "direct_commit");
  assert.equal(normalizeDeliveryMode("open_pr"), "open_pr");
});

test("renderDistributionSummaryMarkdown describes dry-run workflow changes", () => {
  const markdown = renderDistributionSummaryMarkdown({
    generatedDate: "2026-07-05",
    actor: "UltraProdigy",
    dryRun: true,
    repositorySelectionMode: "blacklist",
    deliveryMode: "open_pr",
    selectedRepositories: [
      { full_name: "example/alpha" },
      { full_name: "example/beta" },
    ],
    skippedRepositories: [
      { repository: "example/archived", reason: "archived" },
    ],
    results: [
      { repository: "example/alpha", status: "would_create", branch: "label-sync/update-label-test-workflow" },
      { repository: "example/beta", status: "unchanged", branch: "label-sync/update-label-test-workflow" },
    ],
  });

  assert.match(markdown, /^# Distribute Label Workflow Fake Changelog\n\n/);
  assert.match(markdown, /- \*\*Generated On:\*\* 2026-07-05\n/);
  assert.match(markdown, /- \*\*Test Mode:\*\* True\n/);
  assert.match(markdown, /- \*\*Repository Selection Mode:\*\* Blacklist\n/);
  assert.match(markdown, /- \*\*Delivery Mode:\*\* Pull Request\n/);
  assert.match(markdown, /- \*\*Created:\*\* 1\n/);
  assert.match(markdown, /- \*\*Unchanged:\*\* 1\n/);
  assert.doesNotMatch(markdown, /Would Create|Would Update|04 -/);
  assert.match(markdown, /\| \[example\/alpha\]\(https:\/\/github.com\/example\/alpha\) \| Created \| label-sync\/update-label-test-workflow \|  \|/);
  assert.match(markdown, /\[example\/archived\]\(https:\/\/github.com\/example\/archived\) - archived/);
});

test("renderDistributionSummaryMarkdown labels repository override mode as custom", () => {
  const markdown = renderDistributionSummaryMarkdown({
    generatedDate: "2026-07-06",
    actor: "UltraProdigy",
    dryRun: false,
    repositorySelectionMode: "custom",
    deliveryMode: "direct_commit",
    selectedRepositories: [
      { full_name: "example/alpha" },
    ],
    skippedRepositories: [],
    results: [
      { repository: "example/alpha", status: "updated", branch: "main" },
    ],
  });

  assert.match(markdown, /- \*\*Repository Selection Mode:\*\* Custom\n/);
});

test("renderDistributionSummaryMarkdown shows the failed stage and repositories after the stop point", () => {
  const markdown = renderDistributionSummaryMarkdown({
    generatedDate: "2026-07-13",
    actor: "UltraProdigy",
    dryRun: false,
    repositorySelectionMode: "blacklist",
    deliveryMode: "open_pr",
    selectedRepositories: [
      { full_name: "example/one" },
      { full_name: "example/two" },
      { full_name: "example/three" },
    ],
    skippedRepositories: [
      { repository: "example/empty", reason: "empty" },
    ],
    results: [
      { repository: "example/one", status: "created", branch: "label-sync/update-label-test-workflow" },
      {
        repository: "example/two",
        status: "failed",
        stage: "workflow_file",
        branch: "label-sync/update-label-test-workflow",
        error: "write rejected",
      },
      {
        repository: "example/three",
        status: "not_processed",
        branch: "label-sync/update-label-test-workflow",
        error: "Stopped after failure in example/two.",
      },
    ],
  });

  assert.match(markdown, /- \*\*Not Processed:\*\* 1\n/);
  assert.match(markdown, /Failed during workflow_file: write rejected/);
  assert.match(markdown, /Not Processed: Stopped after failure in example\/two\./);
  assert.match(markdown, /\[example\/empty\].* - empty/);
});
