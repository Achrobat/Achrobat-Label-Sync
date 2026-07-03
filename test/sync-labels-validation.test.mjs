import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const workspaceRoot = path.resolve(import.meta.dirname, "..");
const syncLabelsScript = path.join(workspaceRoot, "scripts", "sync-labels.mjs");

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function createValidationWorkspace() {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "label-sync-validation-"));
  const configPath = path.join(workspace, "config");

  await fs.mkdir(configPath);
  await writeJson(path.join(configPath, "properties.jsonc"), {
    organization: "example",
    labelSyncTokenSecretName: "LABEL_SYNC_TOKEN",
  });
  await writeJson(path.join(configPath, "labels.jsonc"), [
    {
      name: "Bug Fix",
      color: "0e8a16",
      description: "Fixes a confirmed defect",
    },
  ]);
  await writeJson(path.join(configPath, "deleted-labels.jsonc"), []);
  await writeJson(path.join(configPath, "github-default-labels.jsonc"), [
    {
      name: "bug",
      color: "d73a4a",
      description: "Something isn't working",
    },
  ]);
  await writeJson(path.join(configPath, "repository-filter.jsonc"), {
    useWhitelist: true,
    whitelist: [],
    blacklist: [],
  });

  return workspace;
}

async function validateSyncLabels(workspace, env) {
  return execFileAsync(
    process.execPath,
    [syncLabelsScript, "--validate-only"],
    {
      cwd: workspace,
      env: {
        ...process.env,
        ...env,
      },
    },
  );
}

test("sync-labels validation allows replacement sources from GitHub defaults when default deletion is enabled", async () => {
  const workspace = await createValidationWorkspace();

  try {
    const { stdout } = await validateSyncLabels(workspace, {
      DELETE_GITHUB_DEFAULT_LABELS: "true",
      LABEL_REPLACEMENTS: "bug=Bug Fix",
    });

    assert.match(stdout, /Configuration is valid\./);
  } finally {
    await fs.rm(workspace, { force: true, recursive: true });
  }
});

test("sync-labels validation rejects GitHub default replacement sources when default deletion is disabled", async () => {
  const workspace = await createValidationWorkspace();

  try {
    await assert.rejects(
      validateSyncLabels(workspace, {
        DELETE_GITHUB_DEFAULT_LABELS: "false",
        LABEL_REPLACEMENTS: "bug=Bug Fix",
      }),
      /Label replacement source "bug" must exist in config\/deleted-labels\.jsonc/,
    );
  } finally {
    await fs.rm(workspace, { force: true, recursive: true });
  }
});
