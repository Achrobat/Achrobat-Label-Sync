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

test("review refresh workflow downloads the unprivileged review signal before rerunning the authoritative label test", async () => {
  const workflow = await fs.readFile(
    path.join(workflowsDirectory, "refresh-label-test.yml"),
    "utf8",
  );

  assert.match(workflow, /workflow_call:/);
  assert.match(workflow, /actions:\s*write/);
  assert.match(workflow, /review_signal_run_id:/);
  assert.match(workflow, /review_signal_head_sha:/);
  assert.match(workflow, /uses:\s*actions\/download-artifact@v8/);
  assert.match(workflow, /name:\s*label-test-review-context/);
  assert.match(workflow, /run-id:\s*\$\{\{ inputs\.review_signal_run_id \}\}/);
  assert.match(workflow, /github-token:\s*\$\{\{ github\.token \}\}/);
  assert.match(workflow, /uses:\s*actions\/checkout@v7/);
  assert.match(workflow, /uses:\s*actions\/setup-node@v6/);
  assert.match(workflow, /node-version:\s*"24"/);
  assert.match(workflow, /PULL_REQUEST_NUMBER_FILE:\s*\$\{\{ runner\.temp \}\}\/label-test-review-context\/pr-number\.txt/);
  assert.match(workflow, /REVIEW_SIGNAL_HEAD_SHA:\s*\$\{\{ inputs\.review_signal_head_sha \}\}/);
  assert.match(workflow, /TARGET_REPOSITORY:\s*\$\{\{ github\.repository \}\}/);
  assert.doesNotMatch(workflow, /inputs\.pull_request_number/);
  assert.doesNotMatch(workflow, /inputs\.target_repository/);
  assert.match(workflow, /GITHUB_TOKEN:\s*\$\{\{ github\.token \}\}/);
  assert.match(workflow, /run:\s*node scripts\/rerun-label-policy\.mjs/);

  assert.doesNotMatch(workflow, /github\.event\.pull_request/);
});

test("the reusable label test routes policy and refresh events inside one job", async () => {
  const workflow = await fs.readFile(
    path.join(workflowsDirectory, "label-test.yml"),
    "utf8",
  );

  assert.match(workflow, /workflow_call:/);
  assert.match(workflow, /review_signal_run_id:/);
  assert.match(workflow, /review_signal_head_sha:/);
  assert.match(workflow, /actions:\s*read/);
  assert.doesNotMatch(workflow, /actions:\s*write/);
  assert.match(workflow, /jobs:\s*\n\s*label-test:\s*\n\s*runs-on:/);
  assert.equal(workflow.match(/^ {2}[a-z0-9-]+:$/gm).length, 1);
  assert.match(workflow, /name: Download review context\s*\n\s*if:\s*\$\{\{ github\.event_name == 'workflow_run' \}\}/);
  assert.match(workflow, /uses:\s*actions\/download-artifact@v8/);
  assert.match(workflow, /PULL_REQUEST_NUMBER:\s*\$\{\{ github\.event\.pull_request\.number \}\}/);
  assert.match(workflow, /name: Check PR labels and approvals\s*\n\s*if:\s*\$\{\{ github\.event_name == 'pull_request_target' \}\}/);
  assert.match(workflow, /run:\s*node scripts\/check-pr-label-policy\.mjs/);
  assert.match(workflow, /name: Rerun authoritative Label Test\s*\n\s*if:\s*\$\{\{ github\.event_name == 'workflow_run' \}\}/);
  assert.match(workflow, /PULL_REQUEST_NUMBER_FILE:\s*\$\{\{ runner\.temp \}\}\/label-test-review-context\/pr-number\.txt/);
  assert.match(workflow, /REVIEW_SIGNAL_HEAD_SHA:\s*\$\{\{ inputs\.review_signal_head_sha \}\}/);
  assert.match(workflow, /run:\s*node scripts\/rerun-label-policy\.mjs/);
  assert.doesNotMatch(workflow, /inputs\.pull_request_number/);
  assert.doesNotMatch(workflow, /inputs\.target_repository/);
});
