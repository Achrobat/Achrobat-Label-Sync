import assert from "node:assert/strict";
import test from "node:test";

import {
  createLabelReplacementEntry,
  renderLabelSyncSummaryLines,
  summarizeChangelogResults,
} from "../scripts/sync-labels.mjs";

test("createLabelReplacementEntry records field snapshots for migrated replacements", () => {
  const entry = createLabelReplacementEntry({
    existingOld: {
      name: "bug",
      color: "D73A4A",
      description: "Something isn't working",
    },
    desiredNew: {
      name: "Bug Fix",
      color: "77f74f",
      description: "Fixes a bug. Please link it in the PR if an issue exists for it.",
    },
    mode: "migrated",
    counts: {
      matchedIssues: 1,
      matchedPullRequests: 2,
      addedIssues: 1,
      addedPullRequests: 1,
    },
  });

  assert.deepEqual(entry, {
    oldName: "bug",
    newName: "Bug Fix",
    mode: "migrated",
    matchedIssues: 1,
    matchedPullRequests: 2,
    addedIssues: 1,
    addedPullRequests: 1,
    before: {
      name: "bug",
      color: "d73a4a",
      description: "Something isn't working",
    },
    after: {
      name: "Bug Fix",
      color: "77f74f",
      description: "Fixes a bug. Please link it in the PR if an issue exists for it.",
    },
  });
});

test("summarizeChangelogResults totals affected issues and pull requests", () => {
  const summary = summarizeChangelogResults([
    {
      hasChanges: true,
      createdLabels: [{ name: "new" }],
      labelReplacements: [
        { matchedIssues: 2, matchedPullRequests: 3 },
        { affectedIssues: 1, affectedPullRequests: 4 },
      ],
      deletedConfiguredLabels: [
        { affectedIssues: 5, affectedPullRequests: 6 },
      ],
      deletedGithubDefaultLabels: [
        { affectedIssues: 7, affectedPullRequests: 8 },
      ],
      deletedMissingLabels: [
        { affectedIssues: 9, affectedPullRequests: 10 },
      ],
    },
    {
      hasChanges: false,
      createdLabels: [],
      labelReplacements: [],
      deletedConfiguredLabels: [],
      deletedGithubDefaultLabels: [],
      deletedMissingLabels: [],
    },
  ]);

  assert.equal(summary.affectedIssues, 24);
  assert.equal(summary.affectedPullRequests, 31);
});

test("renderLabelSyncSummaryLines appends affected totals at the bottom", () => {
  const lines = renderLabelSyncSummaryLines({
    generatedDate: "2026-07-03",
    metadata: { actor: "octocat" },
    dryRun: true,
    usingTargetRepositoryOverride: false,
    activeFilterMode: "blacklist",
    deleteGithubDefaultLabels: true,
    deleteMissing: false,
    skippedRepositories: [],
    changelogSummary: {
      repositoriesAffected: 2,
      createdLabels: 3,
      deletedLabels: 4,
      replacedLabels: 1,
      affectedIssues: 24,
      affectedPullRequests: 31,
    },
    labelReplacements: [{ oldName: "bug", newName: "Bug Fix" }],
  });

  assert.deepEqual(lines.slice(-2), [
    "Total Issues Affected: 24",
    "Total PRs Affected: 31",
  ]);
});
