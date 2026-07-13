import fs from "node:fs/promises";
import path from "node:path";

import { readJsonc } from "./lib/config-utils.mjs";
import { validateRepositoryFilter } from "./lib/config-validation.mjs";

const workspaceRoot = process.cwd();
const repositoryFilterPath = path.join(workspaceRoot, "config", "repository-filter.jsonc");

async function main() {
  const repositoryFilter = validateRepositoryFilter(await readJsonc(repositoryFilterPath));
  const settings = repositoryFilter.automaticSync;
  const outputPath = process.env.GITHUB_OUTPUT;

  if (!outputPath) {
    console.log(JSON.stringify(settings, null, 2));
    return;
  }

  const lines = [
    `enabled=${settings.enabled}`,
    `delete_missing=${settings.deleteMissing}`,
    `delete_github_default_labels=${settings.deleteGithubDefaultLabels}`,
    "label_replacements<<LABEL_REPLACEMENTS",
    settings.labelReplacements,
    "LABEL_REPLACEMENTS",
  ];

  await fs.appendFile(outputPath, `${lines.join("\n")}\n`, "utf8");
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
