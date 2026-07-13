import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { readJsonc } from "../scripts/lib/config-utils.mjs";

const execFileAsync = promisify(execFile);
const workspaceRoot = path.resolve(import.meta.dirname, "..");
const resetConfigsScript = path.join(workspaceRoot, "scripts", "reset-configs.mjs");

test("reset-configs can reset label-test-workflow-config.jsonc", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "label-sync-reset-"));
  const configDir = path.join(workspace, "config");
  const configPath = path.join(configDir, "label-test-workflow-config.jsonc");

  try {
    await fs.mkdir(configDir);
    await fs.writeFile(
      configPath,
      JSON.stringify({
        requiredLabels: ["Bug"],
        failingLabels: ["Blocked"],
        protectedLabelApprovals: [
          { label: "Affects Balance", approver: "UltraProdigy" },
        ],
        workflowDistribution: {
          whitelist: ["example-repo"],
          blacklist: ["other-repo"],
        },
      }),
      "utf8",
    );

    const { stdout } = await execFileAsync(
      process.execPath,
      [resetConfigsScript],
      {
        cwd: workspace,
        env: {
          ...process.env,
          RESET_LABEL_TEST_WORKFLOW_CONFIG: "true",
        },
      },
    );

    const resetConfig = await readJsonc(configPath);

    assert.match(stdout, /Reset config\/label-test-workflow-config\.jsonc/);
    assert.deepEqual(resetConfig, {
      requiredLabels: [],
      failingLabels: [],
      protectedLabelApprovals: [],
      workflowDistribution: {
        whitelist: [],
        blacklist: [],
      },
    });
  } finally {
    await fs.rm(workspace, { force: true, recursive: true });
  }
});

test("reset-configs restores automatic sync defaults in repository-filter.jsonc", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "label-sync-reset-"));
  const configDir = path.join(workspace, "config");
  const configPath = path.join(configDir, "repository-filter.jsonc");

  try {
    await fs.mkdir(configDir);
    await fs.writeFile(
      configPath,
      JSON.stringify({
        useWhitelist: false,
        automaticSync: {
          enabled: true,
          deleteMissing: true,
          deleteGithubDefaultLabels: false,
          labelReplacements: "bug=Bug Fix",
        },
        whitelist: ["example-repo"],
        blacklist: ["other-repo"],
      }),
      "utf8",
    );

    const { stdout } = await execFileAsync(
      process.execPath,
      [resetConfigsScript],
      {
        cwd: workspace,
        env: {
          ...process.env,
          RESET_REPOSITORY_FILTER: "true",
        },
      },
    );

    const resetConfig = await readJsonc(configPath);

    assert.match(stdout, /Reset config\/repository-filter\.jsonc/);
    assert.deepEqual(resetConfig, {
      useWhitelist: true,
      automaticSync: {
        enabled: false,
        deleteMissing: false,
        deleteGithubDefaultLabels: true,
        labelReplacements: "",
      },
      whitelist: [],
      blacklist: [],
    });
  } finally {
    await fs.rm(workspace, { force: true, recursive: true });
  }
});
