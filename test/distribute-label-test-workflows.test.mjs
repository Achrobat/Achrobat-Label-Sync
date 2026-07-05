import assert from "node:assert/strict";
import test from "node:test";

import {
  generateCallerWorkflow,
  normalizeDeliveryMode,
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
    generatedDate: "2026-07-05T12:00:00.000Z",
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

  assert.match(markdown, /# 04 - Distribute-Label-Workflow Fake/);
  assert.match(markdown, /Test Mode: True/);
  assert.match(markdown, /Repository Selection Mode: Blacklist/);
  assert.match(markdown, /Delivery Mode: Pull Request/);
  assert.match(markdown, /Would Create: 1/);
  assert.match(markdown, /Unchanged: 1/);
  assert.match(markdown, /\| example\/alpha \| Would create \| label-sync\/update-label-test-workflow \|  \|/);
  assert.match(markdown, /example\/archived - archived/);
});
