import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const workspaceRoot = path.resolve(import.meta.dirname, "..");
const workflowsDirectory = path.join(workspaceRoot, ".github", "workflows");

test("workflows use the current stable Node.js action stack", async () => {
  const workflowFiles = (await fs.readdir(workflowsDirectory))
    .filter((fileName) => /\.ya?ml$/i.test(fileName));

  const expectedActionVersions = new Map([
    ["actions/checkout", "v7"],
    ["actions/setup-node", "v6"],
  ]);
  const actionCounts = new Map(
    [...expectedActionVersions.keys()].map((action) => [action, 0]),
  );
  let nodeVersionCount = 0;

  for (const fileName of workflowFiles) {
    const workflow = await fs.readFile(
      path.join(workflowsDirectory, fileName),
      "utf8",
    );

    for (const match of workflow.matchAll(
      /uses:\s*(actions\/(?:checkout|setup-node))@([^\s#]+)/g,
    )) {
      const [, action, version] = match;
      actionCounts.set(action, actionCounts.get(action) + 1);
      assert.equal(
        version,
        expectedActionVersions.get(action),
        `${fileName} must use ${action}@${expectedActionVersions.get(action)}`,
      );
    }

    for (const match of workflow.matchAll(/node-version:\s*["']?([^\s"']+)/g)) {
      nodeVersionCount += 1;
      assert.equal(match[1], "24", `${fileName} must use Node.js 24`);
    }
  }

  for (const [action, count] of actionCounts) {
    assert.ok(count > 0, `expected at least one ${action} workflow step`);
  }
  assert.ok(nodeVersionCount > 0, "expected at least one explicit Node.js version");
});

test("review refresh workflow takes the pull request number directly and reruns the authoritative label test", async () => {
  const workflow = await fs.readFile(
    path.join(workflowsDirectory, "refresh-label-test.yml"),
    "utf8",
  );

  assert.match(workflow, /workflow_call:/);
  assert.match(workflow, /actions:\s*write/);
  assert.match(workflow, /uses:\s*actions\/checkout@v7/);
  assert.match(workflow, /uses:\s*actions\/setup-node@v6/);
  assert.match(workflow, /node-version:\s*"24"/);
  // Derived from the caller's context rather than passed in, so the distributed caller
  // workflows do not have to change when this workflow does.
  assert.match(workflow, /PULL_REQUEST_NUMBER:\s*\$\{\{ github\.event\.pull_request\.number \}\}/);
  assert.match(workflow, /TARGET_REPOSITORY:\s*\$\{\{ github\.repository \}\}/);
  assert.doesNotMatch(workflow, /inputs\.pull_request_number/);
  assert.doesNotMatch(workflow, /inputs\.target_repository/);
  assert.match(workflow, /GITHUB_TOKEN:\s*\$\{\{ github\.token \}\}/);
  assert.match(workflow, /run:\s*node scripts\/rerun-label-policy\.mjs/);

  // The artifact handshake is gone. The PR number arrives in the trusted
  // pull_request_review event payload, so no run artifact is downloaded.
  assert.doesNotMatch(workflow, /download-artifact/);
  assert.doesNotMatch(workflow, /label-test-review-context/);
  assert.doesNotMatch(workflow, /review_signal_run_id/);
});

test("the distributed policy workflow is the only required label test check", async () => {
  const workflow = await fs.readFile(
    path.join(workflowsDirectory, "label-test.yml"),
    "utf8",
  );

  assert.match(workflow, /workflow_call:/);
  assert.match(workflow, /PULL_REQUEST_NUMBER:\s*\$\{\{ github\.event\.pull_request\.number \}\}/);
  assert.match(workflow, /run:\s*node scripts\/check-pr-label-policy\.mjs/);
  assert.doesNotMatch(workflow, /actions:\s*write/);
  assert.doesNotMatch(workflow, /inputs\.pull_request_number/);
  assert.doesNotMatch(workflow, /inputs\.target_repository/);
});
