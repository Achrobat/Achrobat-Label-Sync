import assert from "node:assert/strict";
import test from "node:test";

import {
  filterEligibleRepositories,
  formatSkippedRepository,
} from "../scripts/lib/repository-selection.mjs";

test("filterEligibleRepositories skips archived repositories and read-only repositories when writes are required", () => {
  const repositories = [
    {
      full_name: "example/write",
      name: "write",
      archived: false,
      permissions: { pull: true, push: true },
    },
    {
      full_name: "example/archive",
      name: "archive",
      archived: true,
      permissions: { pull: true, push: true },
    },
    {
      full_name: "example/read-only",
      name: "read-only",
      archived: false,
      permissions: { pull: true, push: false, maintain: false, admin: false },
    },
    {
      full_name: "example/admin",
      name: "admin",
      archived: false,
      permissions: { pull: true, admin: true },
    },
  ];

  const { repositories: eligible, skippedRepositories } = filterEligibleRepositories(
    repositories,
    { requireWriteAccess: true },
  );

  assert.deepEqual(eligible.map((repository) => repository.full_name), [
    "example/write",
    "example/admin",
  ]);
  assert.deepEqual(skippedRepositories, [
    { repository: "example/archive", reason: "archived" },
    { repository: "example/read-only", reason: "read-only" },
  ]);
});

test("filterEligibleRepositories keeps read-only repositories when writes are not required", () => {
  const repositories = [
    {
      full_name: "example/read-only",
      name: "read-only",
      archived: false,
      permissions: { pull: true, push: false, maintain: false, admin: false },
    },
    {
      full_name: "example/archive",
      name: "archive",
      archived: true,
      permissions: { pull: true, push: false },
    },
  ];

  const { repositories: eligible, skippedRepositories } = filterEligibleRepositories(
    repositories,
    { requireWriteAccess: false },
  );

  assert.deepEqual(eligible.map((repository) => repository.full_name), ["example/read-only"]);
  assert.deepEqual(skippedRepositories, [
    { repository: "example/archive", reason: "archived" },
  ]);
});

test("formatSkippedRepository renders a stable skipped repository list item", () => {
  assert.equal(
    formatSkippedRepository({ repository: "example/archive", reason: "archived" }),
    "`example/archive` - archived",
  );
});
