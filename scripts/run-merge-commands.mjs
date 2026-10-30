import path from "node:path";
import { pathToFileURL } from "node:url";
import { assert, normalizeName, readJsonc } from "./lib/config-utils.mjs";
import { validateProperties } from "./lib/config-validation.mjs";
import { loadLabelTestAndCommandsConfig } from "./lib/load-command-config.mjs";
import { resolveCommitIdentity } from "./lib/command-utils.mjs";
import { createGitCherryPicker } from "./lib/git-cherry-pick.mjs";
import { isCherryPickEnabled, isReleaseEnabled, runMergeCommands } from "./lib/merge-commands.mjs";
import {
  createStatusAwareGithubRequest,
  createTeamMembershipChecker,
  createWaitForMergeActorChecker,
} from "./lib/wait-for-merge-runner.mjs";

// Runs /cherry-pick and /release for a pull request that just closed. Started by the "pull-request-closed"
// repository_dispatch (the same one that finishes waits) or by hand to retry. The payload only names the pull
// request: the repository must be in the organization, and whether it merged and what was asked are read
// again from the API.

const workspaceRoot = process.cwd();
const propertiesPath = path.join(workspaceRoot, "config", "properties.jsonc");

export function readMergeTarget({ repository, number, organization }) {
  if (!repository && !number) {
    return null;
  }

  assert(typeof repository === "string" && /^[^/\s]+\/[^/\s]+$/.test(repository), "TARGET_REPOSITORY must match owner/repo.");
  assert(/^[1-9]\d*$/.test(String(number ?? "")), "PULL_REQUEST_NUMBER must be a number.");

  if (normalizeName(repository.split("/")[0]) !== normalizeName(organization)) {
    return { skip: `${repository} is not in the ${organization} organization.` };
  }

  return { repository, number: Number(number) };
}

async function main() {
  const properties = validateProperties(await readJsonc(propertiesPath), {
    requireOrganization: true,
    requireLabelSyncTokenSecretName: false,
  });
  const config = await loadLabelTestAndCommandsConfig(workspaceRoot);

  if (!isCherryPickEnabled(config) && !isReleaseEnabled(config)) {
    console.log("Neither cherryPick nor release is enabled in config/commands.jsonc; nothing to do.");
    return;
  }

  const target = readMergeTarget({
    repository: process.env.TARGET_REPOSITORY,
    number: process.env.PULL_REQUEST_NUMBER,
    organization: properties.organization,
  });

  if (!target) {
    console.log("No pull request was named; nothing to do.");
    return;
  }

  if (target.skip) {
    console.log(target.skip);
    return;
  }

  const token = process.env.LABEL_SYNC_TOKEN;
  assert(token, "LABEL_SYNC_TOKEN is required: merge commands use the configured PAT or GitHub App token.");
  const request = createStatusAwareGithubRequest(token);

  await runMergeCommands({
    request,
    config,
    repository: target.repository,
    number: target.number,
    isTeamMember: createTeamMembershipChecker(request, properties.organization),
    isAutomationActor: createWaitForMergeActorChecker(request),
    cherryPick: createGitCherryPicker({ token, identity: await resolveCommitIdentity(request) }),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
