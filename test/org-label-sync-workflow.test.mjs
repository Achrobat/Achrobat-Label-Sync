import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const workspaceRoot = path.resolve(import.meta.dirname, "..");
const workflowPath = path.join(workspaceRoot, ".github", "workflows", "01-org-label-sync.yml");

test("Org-Label-Sync loads automatic settings on its daily schedule", async () => {
  const workflow = await fs.readFile(workflowPath, "utf8");

  assert.match(workflow, /schedule:\r?\n\s+- cron: "0 0 \* \* \*"/);
  assert.match(workflow, /automatic-settings:[\s\S]*run: node scripts\/export-automatic-sync-settings\.mjs/);
  assert.match(workflow, /enabled: \$\{\{ steps\.settings\.outputs\.enabled \}\}/);
  assert.match(workflow, /delete_missing: \$\{\{ steps\.settings\.outputs\.delete_missing \}\}/);
  assert.match(workflow, /delete_github_default_labels: \$\{\{ steps\.settings\.outputs\.delete_github_default_labels \}\}/);
  assert.match(workflow, /label_replacements: \$\{\{ steps\.settings\.outputs\.label_replacements \}\}/);
});

test("Org-Label-Sync skips automatic work when scheduled sync is disabled", async () => {
  const workflow = await fs.readFile(workflowPath, "utf8");

  assert.match(
    workflow,
    /refresh-config:[\s\S]*needs: automatic-settings[\s\S]*if: \$\{\{ github\.event_name != 'schedule' \|\| needs\.automatic-settings\.outputs\.enabled == 'true' \}\}/,
  );
  assert.match(workflow, /sync-org:\r?\n\s+needs: \[automatic-settings, refresh-config\]/);
});

test("Org-Label-Sync keeps manual inputs separate from scheduled settings", async () => {
  const workflow = await fs.readFile(workflowPath, "utf8");

  assert.match(
    workflow,
    /DELETE_MISSING: \$\{\{ github\.event_name == 'schedule' && needs\.automatic-settings\.outputs\.delete_missing \|\| inputs\.delete_missing \}\}/,
  );
  assert.match(
    workflow,
    /DELETE_GITHUB_DEFAULT_LABELS: \$\{\{ github\.event_name == 'schedule' && needs\.automatic-settings\.outputs\.delete_github_default_labels \|\| inputs\.delete_github_default_labels \}\}/,
  );
  assert.match(
    workflow,
    /LABEL_REPLACEMENTS: \$\{\{ github\.event_name == 'schedule' && needs\.automatic-settings\.outputs\.label_replacements \|\| inputs\.label_replacements \}\}/,
  );
  assert.match(workflow, /DRY_RUN: \$\{\{ inputs\.dry_run \}\}/);
  assert.match(workflow, /TARGET_REPOSITORIES: \$\{\{ inputs\.repositories \}\}/);
});
