import assert from "node:assert/strict";
import test from "node:test";

import {
  generateCallerWorkflow,
  normalizeDeliveryMode,
  parseTargetRepositories,
  renderDistributionSummaryMarkdown,
  selectDistributionRepositories,
} from "../scripts/distribute-label-test-workflows.mjs";

const repositories = [
  { name: "alpha", full_name: "example/alpha", archived: false, permissions: { push: true } },
  { name: "beta", full_name: "example/beta", archived: false, permissions: { push: true } },
  { name: "gamma", full_name: "example/gamma", archived: false, permissions: { push: true } },
  { name: "label-sync", full_name: "example/label-sync", archived: false, permissions: { push: true } },
];

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
  assert.match(workflow, /uses: fork-owner\/Label-Sync\/\.github\/workflows\/label-test\.yml@main/);
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
