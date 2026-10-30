import path from "node:path";
import { readJsonc } from "./config-utils.mjs";
import { validateCommandsConfig, validateLabelTestWorkflowConfig } from "./config-validation.mjs";

// Reads config/label-test-workflow-config.jsonc and config/commands.jsonc and returns one object: the Label
// Test rules plus one key per command (waitForMerge, cherryPick, release, team). The wait-for-merge label is
// checked against the Label Test failing and sticky labels, so both files are always validated together.
export async function loadLabelTestAndCommandsConfig(workspaceRoot = process.cwd()) {
  const labelTestWorkflowConfig = validateLabelTestWorkflowConfig(
    await readJsonc(path.join(workspaceRoot, "config", "label-test-workflow-config.jsonc")),
  );
  const commands = validateCommandsConfig(
    await readJsonc(path.join(workspaceRoot, "config", "commands.jsonc")),
    { labelTestWorkflowConfig },
  );

  return { ...labelTestWorkflowConfig, ...commands };
}
