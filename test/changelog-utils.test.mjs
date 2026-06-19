import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { writeChangelog } from "../scripts/lib/changelog-utils.mjs";
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
    assert.match(summary, /\n## Changed Repositories\n\n### example\/repo\n\n/);
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
    assert.match(summary, /## Changed Repositories\n\n### example\/changed\n\n/);
    assert.match(summary, /## Skipped Repositories\n\n- `example\/archive` - archived\n- `example\/read-only` - read-only\n\n/);
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
});
