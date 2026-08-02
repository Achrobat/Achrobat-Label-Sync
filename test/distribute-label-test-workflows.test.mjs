import assert from "node:assert/strict";
import test from "node:test";

import {
  generateCallerWorkflow,
  generateCallerWorkflows,
  normalizeDeliveryMode,
  parseTargetRepositories,
  processDistributionRepositories,
  removeCallerWorkflow,
  renderDistributionSummaryMarkdown,
  selectDistributionRepositories,
  writeCallerWorkflow,
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
    async deleteFileContent(token, repository, filePath, options) {
      calls.push({ operation: "deleteFileContent", repository, filePath, options });
      return { commit: { sha: "delete-commit-sha" } };
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

test("writeCallerWorkflow reads and writes the requested generated workflow path", async () => {
  const { api, calls } = createFakeDistributionApi({ updateBranchExists: true });

  await writeCallerWorkflow("token", {
    full_name: "example/alpha",
    owner: { login: "example" },
  }, {
    deliveryMode: "open_pr",
    content: "name: Review signal\n",
    filePath: ".github/workflows/label-test-review-refresh.yml",
    commitMessage: "Update Label Test review refresh workflow",
    dryRun: false,
    defaultBranch: "main",
    defaultRef: { object: { sha: "default-sha" } },
    api,
  });

  const fileCalls = calls.filter((call) => (
    call.operation === "getFileContent" || call.operation === "putFileContent"
  ));
  assert.ok(fileCalls.length > 0);
  assert.ok(fileCalls.every((call) => (
    call.filePath === ".github/workflows/label-test-review-refresh.yml"
  )));
  const writeCall = calls.find((call) => call.operation === "putFileContent");
  assert.equal(writeCall.options.message, "Update Label Test review refresh workflow");
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

test("removeCallerWorkflow deletes an obsolete workflow from the default branch", async () => {
  const { api, calls } = createFakeDistributionApi({
    defaultContent: "name: Obsolete refresh\n",
  });

  const result = await removeCallerWorkflow("token", {
    full_name: "example/alpha",
    owner: { login: "example" },
  }, {
    deliveryMode: "direct_commit",
    filePath: ".github/workflows/label-test-review-signal.yml",
    dryRun: false,
    defaultBranch: "main",
    defaultRef: { object: { sha: "default-sha" } },
    api,
  });

  const deleteCall = calls.find((call) => call.operation === "deleteFileContent");
  assert.equal(deleteCall.filePath, ".github/workflows/label-test-review-signal.yml");
  assert.equal(deleteCall.options.branch, "main");
  assert.equal(deleteCall.options.sha, "main-file-sha");
  assert.equal(result.status, "updated");
});

test("removeCallerWorkflow deletes an obsolete workflow on the update branch and reuses its PR", async () => {
  const pullRequest = { number: 12, html_url: "https://github.com/example/alpha/pull/12" };
  const { api, calls } = createFakeDistributionApi({
    updateContent: "name: Obsolete refresh\n",
    updateBranchExists: true,
    pullRequest,
  });

  const result = await removeCallerWorkflow("token", {
    full_name: "example/alpha",
    owner: { login: "example" },
  }, {
    deliveryMode: "open_pr",
    filePath: ".github/workflows/label-test-review-signal.yml",
    dryRun: false,
    defaultBranch: "main",
    defaultRef: { object: { sha: "default-sha" } },
    api,
  });

  const deleteCall = calls.find((call) => call.operation === "deleteFileContent");
  assert.equal(deleteCall.options.branch, "label-sync/update-label-test-workflow");
  assert.equal(result.pullRequest, pullRequest);
});

test("writeCallerWorkflows delivers every generated workflow as one repository result", async () => {
  const calls = [];
  const write = async (token, repository, options) => {
    calls.push({ token, repository: repository.full_name, options });
    const statuses = {
      ".github/workflows/label-test.yml": "unchanged",
      ".github/workflows/label-test-review-refresh.yml": "created",
    };
    const result = {
      repository: repository.full_name,
      status: statuses[options.filePath],
      branch: "label-sync/update-label-test-workflow",
    };

    return result;
  };
  const remove = async (token, repository, options) => {
    calls.push({ token, repository: repository.full_name, options, remove: true });
    return {
      repository: repository.full_name,
      status: "updated",
      branch: "label-sync/update-label-test-workflow",
      pullRequest: { number: 12, html_url: "https://github.com/example/alpha/pull/12" },
    };
  };
  const workflows = [
    { path: ".github/workflows/label-test.yml", content: "policy" },
    { path: ".github/workflows/label-test-review-refresh.yml", content: "signal" },
  ];

  const result = await writeCallerWorkflows("token", {
    full_name: "example/alpha",
  }, {
    workflows,
    deliveryMode: "open_pr",
    dryRun: false,
    defaultBranch: "main",
    defaultRef: { object: { sha: "default-sha" } },
    write,
    remove,
  });

  assert.deepEqual(calls.map((call) => call.options.filePath), [
    ...workflows.map((workflow) => workflow.path),
    ".github/workflows/label-test-review-signal.yml",
  ]);
  assert.ok(calls.every((call) => call.options.deliveryMode === "open_pr"));
  assert.equal(result.status, "updated");
  assert.equal(result.branch, "label-sync/update-label-test-workflow");
  assert.equal(result.pullRequest.number, 12);
});

test("writeCallerWorkflows preserves dry-run status without applying later workflows", async () => {
  const writes = [];
  const write = async (token, repository, options) => {
    writes.push(options.filePath);
    return {
      repository: repository.full_name,
      status: options.filePath.endsWith("label-test.yml") ? "unchanged" : "would_create",
      branch: "label-sync/update-label-test-workflow",
    };
  };
  const remove = async (token, repository, options) => {
    writes.push(options.filePath);
    return {
      repository: repository.full_name,
      status: "would_update",
      branch: "label-sync/update-label-test-workflow",
    };
  };

  const result = await writeCallerWorkflows("token", { full_name: "example/alpha" }, {
    workflows: [
      { path: ".github/workflows/label-test.yml", content: "policy" },
      { path: ".github/workflows/label-test-review-refresh.yml", content: "signal" },
    ],
    deliveryMode: "open_pr",
    dryRun: true,
    write,
    remove,
  });

  assert.equal(writes.length, 3);
  assert.equal(result.status, "would_update");
});

test("writeCallerWorkflows stops at the first workflow-file failure", async () => {
  const writes = [];
  const write = async (token, repository, options) => {
    writes.push(options.filePath);

    if (options.filePath.endsWith("review-refresh.yml")) {
      throw new Error("signal write rejected");
    }

    return {
      repository: repository.full_name,
      status: "updated",
      branch: "main",
    };
  };

  await assert.rejects(
    () => writeCallerWorkflows("token", { full_name: "example/alpha" }, {
      workflows: [
        { path: ".github/workflows/label-test.yml", content: "policy" },
        { path: ".github/workflows/label-test-review-refresh.yml", content: "signal" },
      ],
      deliveryMode: "direct_commit",
      dryRun: false,
      write,
    }),
    /signal write rejected/,
  );
  assert.deepEqual(writes, [
    ".github/workflows/label-test.yml",
    ".github/workflows/label-test-review-refresh.yml",
  ]);
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
  assert.match(workflow, /uses: fork-owner\/Label-Sync\/\.github\/workflows\/97-label-test\.yml@main/);
  assert.match(workflow, /label_sync_repository: fork-owner\/Label-Sync/);
  assert.match(workflow, /label_sync_ref: main/);
  assert.match(workflow, /target_repository: \$\{\{ github\.repository \}\}/);
  assert.match(workflow, /pull_request_number: \$\{\{ github\.event\.pull_request\.number \}\}/);
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
  assert.match(policy, /uses: fork-owner\/Label-Sync\/\.github\/workflows\/97-label-test\.yml@main/);
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

  const refresh = byPath.get(".github/workflows/label-test-review-refresh.yml");
  assert.match(refresh, /name: Label Test Review Refresh/);
  assert.match(refresh, /pull_request_review:/);
  assert.match(refresh, /- submitted/);
  assert.match(refresh, /- edited/);
  assert.match(refresh, /- dismissed/);
  assert.match(refresh, /name: Refresh Label Test/);
  assert.match(refresh, /actions:\s*write/);
  assert.match(refresh, /uses: fork-owner\/Label-Sync\/\.github\/workflows\/96-refresh-label-test\.yml@main/);
  assert.match(refresh, /pull_request_number: \$\{\{ github\.event\.pull_request\.number \}\}/);
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
