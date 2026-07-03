import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { renderLabelSyncSection, renderRemoveLabelsSection, writeChangelog } from "../scripts/lib/changelog-utils.mjs";
import { renderInventorySummary } from "../scripts/inventory-labels.mjs";

test("writeChangelog appends unchanged Markdown formatting to the GitHub step summary", async () => {
  const originalCwd = process.cwd();
  const originalSummaryPath = process.env.GITHUB_STEP_SUMMARY;
  const originalGithubEnv = {
    GITHUB_ACTOR: process.env.GITHUB_ACTOR,
    GITHUB_REPOSITORY: process.env.GITHUB_REPOSITORY,
    GITHUB_RUN_ID: process.env.GITHUB_RUN_ID,
    GITHUB_RUN_NUMBER: process.env.GITHUB_RUN_NUMBER,
    GITHUB_SERVER_URL: process.env.GITHUB_SERVER_URL,
  };

  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "label-sync-changelog-"));
  const summaryPath = path.join(workspace, "step-summary.md");

  try {
    process.chdir(workspace);
    process.env.GITHUB_STEP_SUMMARY = summaryPath;
    process.env.GITHUB_ACTOR = "octocat";
    process.env.GITHUB_REPOSITORY = "example/labels";
    process.env.GITHUB_RUN_ID = "12345";
    process.env.GITHUB_RUN_NUMBER = "17";
    process.env.GITHUB_SERVER_URL = "https://github.com";

    const result = await writeChangelog({
      workflowName: "Org-Label-Sync Fake",
      summaryLines: ({ generatedDate, metadata, workflowRun }) => [
        `Generated On: ${generatedDate}`,
        `Workflow Run: ${workflowRun}`,
        `Actor: ${metadata.actor}`,
        "Test Mode: True",
      ],
      sections: [
        {
          repository: "example/repo",
          hasChanges: true,
          lines: [
            "Created labels:",
            "- Created `status: ready` (#0e8a16): Ready to merge",
          ],
        },
      ],
    });

    const summary = await fs.readFile(summaryPath, "utf8");
    assert.equal(result, summaryPath);
    assert.match(summary, /^# Org-Label-Sync Fake Changelog\n\n/);
    assert.match(summary, /- \*\*Generated On:\*\* \d{4}-\d{2}-\d{2}\n/);
    assert.doesNotMatch(summary, /Workflow Run:/);
    assert.match(summary, /- \*\*Actor:\*\* octocat\n/);
    assert.match(summary, /- \*\*Test Mode:\*\* True\n/);
    assert.match(summary, /\n## Changed Repositories\n\n### \[example\/repo\]\(https:\/\/github.com\/example\/repo\)\n\n/);
    assert.match(summary, /Created labels:\n- Created `status: ready` \(#0e8a16\): Ready to merge\n\n$/);
    await assert.rejects(fs.stat(path.join(workspace, "changelogs")), { code: "ENOENT" });
  } finally {
    process.chdir(originalCwd);
    process.env.GITHUB_STEP_SUMMARY = originalSummaryPath;
    for (const [key, value] of Object.entries(originalGithubEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await fs.rm(workspace, { force: true, recursive: true });
  }
});

test("writeChangelog omits workflow run details from default summary lines", async () => {
  const originalCwd = process.cwd();
  const originalSummaryPath = process.env.GITHUB_STEP_SUMMARY;
  const originalGithubEnv = {
    GITHUB_ACTOR: process.env.GITHUB_ACTOR,
    GITHUB_REPOSITORY: process.env.GITHUB_REPOSITORY,
    GITHUB_RUN_ID: process.env.GITHUB_RUN_ID,
    GITHUB_RUN_NUMBER: process.env.GITHUB_RUN_NUMBER,
    GITHUB_SERVER_URL: process.env.GITHUB_SERVER_URL,
  };

  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "label-sync-changelog-"));
  const summaryPath = path.join(workspace, "step-summary.md");

  try {
    process.chdir(workspace);
    process.env.GITHUB_STEP_SUMMARY = summaryPath;
    process.env.GITHUB_ACTOR = "octocat";
    process.env.GITHUB_REPOSITORY = "example/labels";
    process.env.GITHUB_RUN_ID = "12345";
    process.env.GITHUB_RUN_NUMBER = "17";
    process.env.GITHUB_SERVER_URL = "https://github.com";

    await writeChangelog({
      workflowName: "Config-Label-Sync",
      introLines: ["Target Repository: example/repo"],
      sections: [
        {
          repository: "example/repo",
          hasChanges: true,
          lines: ["Created labels:", "- Created `status: ready` (#0e8a16)"],
        },
      ],
    });

    const summary = await fs.readFile(summaryPath, "utf8");
    assert.match(summary, /- Generated: \d{4}-\d{2}-\d{2}T/);
    assert.doesNotMatch(summary, /Workflow run:/i);
    assert.match(summary, /- Actor: octocat\n/);
  } finally {
    process.chdir(originalCwd);
    process.env.GITHUB_STEP_SUMMARY = originalSummaryPath;
    for (const [key, value] of Object.entries(originalGithubEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await fs.rm(workspace, { force: true, recursive: true });
  }
});

test("writeChangelog includes skipped repositories and failure details when provided", async () => {
  const originalCwd = process.cwd();
  const originalSummaryPath = process.env.GITHUB_STEP_SUMMARY;
  const originalGithubEnv = {
    GITHUB_ACTOR: process.env.GITHUB_ACTOR,
    GITHUB_REPOSITORY: process.env.GITHUB_REPOSITORY,
    GITHUB_RUN_ID: process.env.GITHUB_RUN_ID,
    GITHUB_RUN_NUMBER: process.env.GITHUB_RUN_NUMBER,
    GITHUB_SERVER_URL: process.env.GITHUB_SERVER_URL,
  };

  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "label-sync-changelog-"));
  const summaryPath = path.join(workspace, "step-summary.md");

  try {
    process.chdir(workspace);
    process.env.GITHUB_STEP_SUMMARY = summaryPath;
    process.env.GITHUB_ACTOR = "octocat";
    process.env.GITHUB_REPOSITORY = "example/labels";
    process.env.GITHUB_RUN_ID = "12345";
    process.env.GITHUB_RUN_NUMBER = "17";
    process.env.GITHUB_SERVER_URL = "https://github.com";

    await writeChangelog({
      workflowName: "Org-Label-Sync",
      summaryLines: () => [
        "Generated On: 2026-06-17",
        "Repositories Skipped: 2",
      ],
      skippedRepositories: [
        { repository: "example/archive", reason: "archived" },
        { repository: "example/read-only", reason: "read-only" },
      ],
      failure: new Error("PATCH /repos/example/broken/labels/bug failed with 500"),
      sections: [
        {
          repository: "example/changed",
          hasChanges: true,
          lines: ["Created labels:", "- Created `bug` (#d73a4a)"],
        },
      ],
    });

    const summary = await fs.readFile(summaryPath, "utf8");
    assert.match(summary, /## Changed Repositories\n\n### \[example\/changed\]\(https:\/\/github.com\/example\/changed\)\n\n/);
    assert.match(summary, /## Skipped Repositories\n\n- \[example\/archive\]\(https:\/\/github.com\/example\/archive\) - archived\n- \[example\/read-only\]\(https:\/\/github.com\/example\/read-only\) - read-only\n\n/);
    assert.match(summary, /## Workflow Failure\n\n- PATCH \/repos\/example\/broken\/labels\/bug failed with 500\n$/);
  } finally {
    process.chdir(originalCwd);
    process.env.GITHUB_STEP_SUMMARY = originalSummaryPath;
    for (const [key, value] of Object.entries(originalGithubEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await fs.rm(workspace, { force: true, recursive: true });
  }
});

test("renderInventorySummary omits workflow run details", () => {
  const summary = renderInventorySummary({
    workflowName: "Inventory-Labels",
    generatedDate: "2026-06-17",
    workflowRun: "[Inventory-Labels #17](https://github.com/example/labels/actions/runs/12345)",
    actor: "octocat",
    repoFilterMode: "repository filter",
    excludeConfiguredLabels: false,
    listSimilarities: false,
    results: [
      {
        repository: "example/repo",
        labels: [
          {
            name: "bug",
            color: "d73a4a",
            description: "Something is not working",
          },
        ],
      },
    ],
    sharedLabelGroups: [],
  });

  assert.match(summary, /^# Inventory-Labels\n\n/);
  assert.match(summary, /- \*\*Generated On:\*\* 2026-06-17\n/);
  assert.doesNotMatch(summary, /Workflow Run:/);
  assert.match(summary, /- \*\*Actor:\*\* octocat\n/);
  assert.match(summary, /\n## Repository Label Inventory\n\n### \[example\/repo\]\(https:\/\/github.com\/example\/repo\)\n\n/);
});

test("renderInventorySummary links shared-label repository names to their repositories", () => {
  const summary = renderInventorySummary({
    workflowName: "Inventory-Labels",
    generatedDate: "2026-06-17",
    actor: "octocat",
    repoFilterMode: "repository filter",
    excludeConfiguredLabels: false,
    listSimilarities: true,
    results: [
      {
        repository: "example/one",
        labels: [],
      },
      {
        repository: "example/two",
        labels: [],
      },
    ],
    sharedLabelGroups: [
      {
        label: {
          name: "bug",
          color: "d73a4a",
          description: "Something is not working",
        },
        repositories: ["example/one", "example/two"],
      },
    ],
  });

  assert.match(summary, /Repositories:\n- \[example\/one\]\(https:\/\/github.com\/example\/one\)\n- \[example\/two\]\(https:\/\/github.com\/example\/two\)\n/);
});

test("renderLabelSyncSection appends affected issue and pull request counts to deleted labels", () => {
  const section = renderLabelSyncSection({
    repository: "example/repo",
    hasChanges: true,
    labelReplacements: [],
    createdLabels: [],
    updatedLabels: [],
    deletedConfiguredLabels: [
      {
        name: "bug",
        color: "d73a4a",
        description: "Something is not working",
        affectedIssues: 1,
        affectedPullRequests: 2,
      },
      {
        name: "cleanup",
        color: "0e8a16",
        description: "",
        affectedIssues: 0,
        affectedPullRequests: 3,
      },
    ],
    deletedGithubDefaultLabels: [
      {
        name: "docs",
        color: "0075ca",
        description: "Improvements or additions to documentation",
        affectedIssues: 1,
        affectedPullRequests: 0,
      },
    ],
    deletedMissingLabels: [
      {
        name: "unused",
        color: "cfd3d7",
        description: "No longer managed",
        affectedIssues: 0,
        affectedPullRequests: 0,
      },
    ],
  });

  assert.deepEqual(section.lines, [
    "Deleted Labels:",
    "- Deleted `bug` (`#d73a4a`): Something is not working (2 PRs, 1 Issue affected)",
    "- Deleted `cleanup` (`#0e8a16`) (3 PRs affected)",
    "- Deleted GitHub default label `docs` (`#0075ca`): Improvements or additions to documentation (1 Issue affected)",
    "- Deleted unmanaged label `unused` (`#cfd3d7`): No longer managed",
  ]);
});

test("renderLabelSyncSection appends affected issue and pull request counts to replacements", () => {
  const section = renderLabelSyncSection({
    repository: "example/repo",
    hasChanges: true,
    labelReplacements: [
      {
        oldName: "bug",
        newName: "type: bug",
        mode: "renamed",
        matchedIssues: 1,
        matchedPullRequests: 2,
      },
      {
        oldName: "feature",
        newName: "type: feature",
        mode: "migrated",
        matchedIssues: 0,
        matchedPullRequests: 3,
      },
      {
        oldName: "stale",
        newName: "status: stale",
        mode: "migrated",
        matchedIssues: 0,
        matchedPullRequests: 0,
      },
    ],
    createdLabels: [],
    updatedLabels: [],
    deletedConfiguredLabels: [],
    deletedGithubDefaultLabels: [],
    deletedMissingLabels: [],
  });

  assert.deepEqual(section.lines, [
    "Label replacements:",
    "- Replaced `bug`: `bug` -> `type: bug` (2 PRs, 1 Issue affected)",
    "- Replaced `feature`: `feature` -> `type: feature` (3 PRs affected)",
    "- Replaced `stale`: `stale` -> `status: stale`",
  ]);
});

test("renderLabelSyncSection combines label replacements and automatic updates with field details", () => {
  const section = renderLabelSyncSection({
    repository: "example/repo",
    hasChanges: true,
    labelReplacements: [
      {
        oldName: "bug",
        newName: "Bug Fix",
        mode: "renamed",
        matchedIssues: 1,
        matchedPullRequests: 2,
        before: {
          name: "bug",
          color: "d73a4a",
          description: "Something is not working",
        },
        after: {
          name: "Bug Fix",
          color: "0e8a16",
          description: "Fixes a confirmed defect",
        },
      },
    ],
    createdLabels: [],
    updatedLabels: [
      {
        before: {
          name: "enhancement",
          color: "a2eeef",
          description: "New feature or request",
        },
        after: {
          name: "Enhancement",
          color: "84b6eb",
          description: "Improve an existing mechanic. Please explain the change with a before/after comparison.",
        },
      },
    ],
    deletedConfiguredLabels: [],
    deletedGithubDefaultLabels: [],
    deletedMissingLabels: [],
  });

  assert.deepEqual(section.lines, [
    "Label replacements:",
    "- Replaced `bug`: `bug` -> `Bug Fix` | `#d73a4a` -> `#0e8a16` | `Something is not working` -> `Fixes a confirmed defect` (2 PRs, 1 Issue affected)",
    "- Replaced `enhancement`: `enhancement` -> `Enhancement` | `#a2eeef` -> `#84b6eb` | `New feature or request` -> `Improve an existing mechanic. Please explain the change with a before/after comparison.`",
  ]);
});

test("renderRemoveLabelsSection includes a per-repository affected count summary", () => {
  const section = renderRemoveLabelsSection({
    repository: "example/repo",
    removedIssues: [
      { number: 7, label: "bug", url: "https://github.com/example/repo/issues/7" },
    ],
    removedPullRequests: [
      { number: 3, label: "bug", url: "https://github.com/example/repo/pull/3" },
      { number: 5, label: "bug", url: "https://github.com/example/repo/pull/5" },
    ],
  });

  assert.equal(section.lines[0], "Removed labels:");
  assert.equal(section.lines[1], "- Removed `bug` (2 PRs, 1 Issue affected)");
});
