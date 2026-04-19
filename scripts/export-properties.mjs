import path from "node:path";
import fs from "node:fs/promises";
import { assert, readJsonc } from "./lib/config-utils.mjs";

const workspaceRoot = process.cwd();
const propertiesPath = path.join(workspaceRoot, "config", "properties.jsonc");

function validateProperties(properties) {
  assert(properties && typeof properties === "object" && !Array.isArray(properties), "config/properties.jsonc must contain an object.");
  assert(
    typeof properties.organization === "string" && properties.organization.trim(),
    "properties.organization must be a non-empty string.",
  );
  assert(
    typeof properties.labelSyncTokenSecretName === "string" && /^[A-Z_][A-Z0-9_]*$/.test(properties.labelSyncTokenSecretName),
    "properties.labelSyncTokenSecretName must look like a GitHub secret name.",
  );

  if (properties.sourceRepository !== undefined) {
    assert(
      typeof properties.sourceRepository === "string" && /^[^/\s]+\/[^/\s]+$/.test(properties.sourceRepository.trim()),
      "properties.sourceRepository must match owner/repo when provided.",
    );
  }

  if (properties.deleteMissingByDefault !== undefined) {
    assert(typeof properties.deleteMissingByDefault === "boolean", "properties.deleteMissingByDefault must be a boolean.");
  }

  return {
    organization: properties.organization.trim(),
    labelSyncTokenSecretName: properties.labelSyncTokenSecretName.trim(),
    sourceRepository: (properties.sourceRepository ?? process.env.GITHUB_REPOSITORY ?? "").trim(),
    deleteMissingByDefault: properties.deleteMissingByDefault ?? false,
  };
}

async function main() {
  const properties = validateProperties(await readJsonc(propertiesPath));
  const outputPath = process.env.GITHUB_OUTPUT;

  if (!outputPath) {
    console.log(JSON.stringify(properties, null, 2));
    return;
  }

  const lines = [
    `organization=${properties.organization}`,
    `label_sync_token_secret_name=${properties.labelSyncTokenSecretName}`,
    `source_repository=${properties.sourceRepository}`,
    `delete_missing_by_default=${properties.deleteMissingByDefault}`,
  ];

  await fs.appendFile(outputPath, `${lines.join("\n")}\n`, "utf8");
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
