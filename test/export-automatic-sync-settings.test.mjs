import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const workspaceRoot = path.resolve(import.meta.dirname, "..");
const exporterScript = path.join(workspaceRoot, "scripts", "export-automatic-sync-settings.mjs");

async function createWorkspace(automaticSync) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "automatic-sync-settings-"));
  const configDir = path.join(workspace, "config");
  await fs.mkdir(configDir);
  await fs.writeFile(
    path.join(configDir, "repository-filter.jsonc"),
    `${JSON.stringify({
      useWhitelist: false,
      automaticSync,
      whitelist: [],
      blacklist: [],
    }, null, 2)}\n`,
    "utf8",
  );
  return workspace;
}

test("export-automatic-sync-settings prints normalized settings outside Actions", async () => {
  const workspace = await createWorkspace(undefined);

  try {
    const { stdout } = await execFileAsync(process.execPath, [exporterScript], {
      cwd: workspace,
      env: { ...process.env, GITHUB_OUTPUT: "" },
    });

    assert.deepEqual(JSON.parse(stdout), {
      enabled: false,
      deleteMissing: false,
      deleteGithubDefaultLabels: true,
      labelReplacements: "",
    });
  } finally {
    await fs.rm(workspace, { force: true, recursive: true });
  }
});

test("export-automatic-sync-settings writes explicit settings to GitHub outputs", async () => {
  const workspace = await createWorkspace({
    enabled: true,
    deleteMissing: true,
    deleteGithubDefaultLabels: false,
    labelReplacements: "bug=Bug Fix, enhancement=Feature",
  });
  const outputPath = path.join(workspace, "github-output.txt");

  try {
    await execFileAsync(process.execPath, [exporterScript], {
      cwd: workspace,
      env: { ...process.env, GITHUB_OUTPUT: outputPath },
    });

    const output = await fs.readFile(outputPath, "utf8");
    assert.equal(output, [
      "enabled=true",
      "delete_missing=true",
      "delete_github_default_labels=false",
      "label_replacements<<LABEL_REPLACEMENTS",
      "bug=Bug Fix, enhancement=Feature",
      "LABEL_REPLACEMENTS",
      "",
    ].join("\n"));
  } finally {
    await fs.rm(workspace, { force: true, recursive: true });
  }
});
