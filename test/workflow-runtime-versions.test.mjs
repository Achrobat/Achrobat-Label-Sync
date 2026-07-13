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
