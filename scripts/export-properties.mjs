import path from "node:path";
import fs from "node:fs/promises";
import { readJsonc } from "./lib/config-utils.mjs";
import { validateProperties } from "./lib/config-validation.mjs";

const workspaceRoot = process.cwd();
const propertiesPath = path.join(workspaceRoot, "config", "properties.jsonc");

async function main() {
  const properties = validateProperties(await readJsonc(propertiesPath), {
    requireOrganization: true,
    requireLabelSyncTokenSecretName: true,
    includeSourceRepository: true,
    defaultSourceRepository: process.env.GITHUB_REPOSITORY ?? "",
    includeDeleteMissingByDefault: true,
  });
  const outputPath = process.env.GITHUB_OUTPUT;

  if (!outputPath) {
    console.log(JSON.stringify(properties, null, 2));
    return;
  }

  const lines = [
    `organization=${properties.organization}`,
    `auth_mode=${properties.authMode}`,
    `label_sync_token_secret_name=${properties.labelSyncTokenSecretName}`,
    `pat_token_secret_name=${properties.labelSyncTokenSecretName}`,
    `github_app_id_secret_name=${properties.githubAppIdSecretName}`,
    `github_app_private_key_secret_name=${properties.githubAppPrivateKeySecretName}`,
    `github_app_installation_id_secret_name=${properties.githubAppInstallationIdSecretName}`,
    `source_repository=${properties.sourceRepository}`,
    `delete_missing_by_default=${properties.deleteMissingByDefault}`,
  ];

  await fs.appendFile(outputPath, `${lines.join("\n")}\n`, "utf8");
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
