import assert from "node:assert/strict";
import test from "node:test";

import {
  filterEligibleRepositories,
  filterRepositoriesForWriteMode,
  formatSkippedRepository,
  parseTokenPermissions,
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

test("filterRepositoriesForWriteMode keeps read-only repositories in dry-run mode", () => {
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

  const { repositories: eligible, skippedRepositories } = filterRepositoriesForWriteMode(
    repositories,
    { dryRun: true },
  );

  assert.deepEqual(eligible.map((repository) => repository.full_name), ["example/read-only"]);
  assert.deepEqual(skippedRepositories, [
    { repository: "example/archive", reason: "archived" },
  ]);
});

test("filterRepositoriesForWriteMode skips read-only repositories when applying changes", () => {
  const repositories = [
    {
      full_name: "example/read-only",
      name: "read-only",
      archived: false,
      permissions: { pull: true, push: false, maintain: false, admin: false },
    },
  ];

  const { repositories: eligible, skippedRepositories } = filterRepositoriesForWriteMode(
    repositories,
    { dryRun: false },
  );

  assert.deepEqual(eligible, []);
  assert.deepEqual(skippedRepositories, [
    { repository: "example/read-only", reason: "read-only" },
  ]);
});

test("filterRepositoriesForWriteMode keeps repositories when token has label write permissions", () => {
  const repositories = [
    {
      full_name: "example/app-token-label-write",
      name: "app-token-label-write",
      archived: false,
      permissions: { pull: true, push: false, maintain: false, admin: false },
    },
  ];

  const { repositories: eligible, skippedRepositories } = filterRepositoriesForWriteMode(
    repositories,
    { dryRun: false, tokenPermissions: { issues: "write" } },
  );

  assert.deepEqual(eligible.map((repository) => repository.full_name), ["example/app-token-label-write"]);
  assert.deepEqual(skippedRepositories, []);
});

test("parseTokenPermissions returns token permissions from a JSON object string", () => {
  assert.deepEqual(
    parseTokenPermissions('{"issues":"write","contents":"read"}'),
    { issues: "write", contents: "read" },
  );
});

test("formatSkippedRepository renders a stable skipped repository list item", () => {
  assert.equal(
    formatSkippedRepository({ repository: "example/archive", reason: "archived" }),
    "`example/archive` - archived",
  );
});
