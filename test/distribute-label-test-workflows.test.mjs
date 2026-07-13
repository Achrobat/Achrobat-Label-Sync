import assert from "node:assert/strict";
import test from "node:test";

import {
  generateCallerWorkflow,
  normalizeDeliveryMode,
  parseTargetRepositories,
  processDistributionRepositories,
  renderDistributionSummaryMarkdown,
  selectDistributionRepositories,
  writeCallerWorkflow,
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

function createFakeDistributionApi({
  defaultContent = null,
  updateContent = null,
  updateBranchExists = true,
  pullRequest = null,
} = {}) {
  const calls = [];
  const api = {
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
      const value = ref === "main" ? defaultContent : updateContent;
      return value === null ? null : { content: encodeContent(value), sha: `${ref}-file-sha` };
    },
    async putFileContent(token, repository, filePath, options) {
      calls.push({ operation: "putFileContent", repository, filePath, options });
      return { content: { sha: "new-file-sha" } };
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

test("writeCallerWorkflow reuses an existing update branch before committing and opening a PR", async () => {
  const { api, calls } = createFakeDistributionApi({ updateBranchExists: true });
  const content = "name: Generated workflow\n";

  const result = await writeCallerWorkflow("token", {
    full_name: "example/alpha",
    owner: { login: "example" },
  }, {
    deliveryMode: "open_pr",
    content,
    dryRun: false,
    defaultBranch: "main",
    defaultRef: { object: { sha: "default-sha" } },
    api,
  });

  assert.equal(calls.filter((call) => call.operation === "createBranchRef").length, 0);
  assert.equal(calls.filter((call) => call.operation === "putFileContent").length, 1);
  assert.equal(calls.filter((call) => call.operation === "createUpdatePullRequest").length, 1);
  assert.equal(result.status, "created");
  assert.equal(result.pullRequest.number, 42);
});

test("writeCallerWorkflow creates a missing PR when the workflow commit already exists", async () => {
  const content = "name: Generated workflow\n";
  const { api, calls } = createFakeDistributionApi({
    defaultContent: "name: Previous workflow\n",
    updateContent: content,
    updateBranchExists: true,
  });

  const result = await writeCallerWorkflow("token", {
    full_name: "example/alpha",
    owner: { login: "example" },
  }, {
    deliveryMode: "open_pr",
    content,
    dryRun: false,
    defaultBranch: "main",
    defaultRef: { object: { sha: "default-sha" } },
    api,
  });

  assert.equal(calls.filter((call) => call.operation === "putFileContent").length, 0);
  assert.equal(calls.filter((call) => call.operation === "createUpdatePullRequest").length, 1);
  assert.equal(result.status, "unchanged");
  assert.equal(result.pullRequest.number, 42);
});

test("writeCallerWorkflow does not create a branch when the default branch is already current", async () => {
  const content = "name: Generated workflow\n";
  const { api, calls } = createFakeDistributionApi({
    defaultContent: content,
    updateBranchExists: false,
  });

  const result = await writeCallerWorkflow("token", {
    full_name: "example/alpha",
    owner: { login: "example" },
  }, {
    deliveryMode: "open_pr",
    content,
    dryRun: false,
    defaultBranch: "main",
    defaultRef: { object: { sha: "default-sha" } },
    api,
  });

  assert.equal(calls.filter((call) => call.operation === "createBranchRef").length, 0);
  assert.equal(calls.filter((call) => call.operation === "putFileContent").length, 0);
  assert.equal(calls.filter((call) => call.operation === "createUpdatePullRequest").length, 0);
  assert.deepEqual(result, {
    repository: "example/alpha",
    status: "unchanged",
    branch: "main",
  });
});

test("writeCallerWorkflow dry-run mode performs no mutations", async () => {
  const { api, calls } = createFakeDistributionApi({
    defaultContent: "name: Previous workflow\n",
    updateBranchExists: false,
  });

  const result = await writeCallerWorkflow("token", {
    full_name: "example/alpha",
    owner: { login: "example" },
  }, {
    deliveryMode: "open_pr",
    content: "name: Generated workflow\n",
    dryRun: true,
    defaultBranch: "main",
    defaultRef: { object: { sha: "default-sha" } },
    api,
  });

  assert.equal(calls.filter((call) => call.operation === "createBranchRef").length, 0);
  assert.equal(calls.filter((call) => call.operation === "putFileContent").length, 0);
  assert.equal(calls.filter((call) => call.operation === "createUpdatePullRequest").length, 0);
  assert.equal(result.status, "would_update");
});

test("writeCallerWorkflow identifies the workflow-file stage on write failure", async () => {
  const { api } = createFakeDistributionApi({ updateBranchExists: true });
  api.putFileContent = async () => {
    throw new Error("write rejected");
  };

  await assert.rejects(
    () => writeCallerWorkflow("token", {
      full_name: "example/alpha",
      owner: { login: "example" },
    }, {
      deliveryMode: "open_pr",
      content: "name: Generated workflow\n",
      dryRun: false,
      defaultBranch: "main",
      defaultRef: { object: { sha: "default-sha" } },
      api,
    }),
    (error) => error.message === "write rejected" && error.stage === "workflow_file",
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

  assert.match(workflow, /name: 97 - Label Test/);
  assert.match(workflow, /pull_request_target:/);
  assert.match(workflow, /pull_request_review:/);
  assert.match(workflow, /uses: fork-owner\/Label-Sync\/\.github\/workflows\/97-label-test\.yml@main/);
  assert.match(workflow, /label_sync_repository: fork-owner\/Label-Sync/);
  assert.match(workflow, /label_sync_ref: main/);
  assert.match(workflow, /target_repository: \$\{\{ github\.repository \}\}/);
  assert.match(workflow, /pull_request_number: \$\{\{ github\.event\.pull_request\.number \}\}/);
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
