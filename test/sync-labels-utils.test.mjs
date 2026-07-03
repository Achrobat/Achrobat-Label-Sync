import assert from "node:assert/strict";
import test from "node:test";

import { createLabelReplacementEntry } from "../scripts/sync-labels.mjs";

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
