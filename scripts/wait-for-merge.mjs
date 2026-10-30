import path from "node:path";
import { pathToFileURL } from "node:url";
import { assert, readJsonc } from "./lib/config-utils.mjs";
import { validateProperties } from "./lib/config-validation.mjs";
import { loadLabelTestAndCommandsConfig } from "./lib/load-command-config.mjs";
import { isWaitForMergeEnabled } from "./lib/wait-for-merge.mjs";
import {
  createPullRequestStateReader,
  createStatusAwareGithubRequest,
  createTeamMembershipChecker,
  createWaitForMergeActorChecker,
  reconcileWaitForMerge,
} from "./lib/wait-for-merge-runner.mjs";

// Central Wait-For-Merge workflow. It finds every open pull request in the organization that has the wait
// label and completes the waits whose linked pull requests are all merged or closed. It runs on a schedule as
// a backstop and on a "pull-request-closed" repository_dispatch, which anything watching the organization
// (for example an organization webhook) can send to make it react within moments. The dispatch payload only
// says that something closed; every pull request is read again from the API.

const workspaceRoot = process.cwd();
const propertiesPath = path.join(workspaceRoot, "config", "properties.jsonc");
const MAX_SEARCH_PAGES = 10;

function escapeWorkflowCommand(value) {
  return String(value).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

export async function findWaitingPullRequests(request, { organization, label }) {
  const query = `is:pr is:open org:${organization} label:"${label.replace(/"/g, "")}"`;
  const pullRequests = [];

  for (let page = 1; page <= MAX_SEARCH_PAGES; page += 1) {
    const response = await request("GET", `/search/issues?q=${encodeURIComponent(query)}&per_page=100&page=${page}`);
    const items = Array.isArray(response?.items) ? response.items : [];

    for (const item of items) {
      const match = /\/repos\/([^/]+\/[^/]+)$/.exec(item?.repository_url ?? "");

      if (match && Number.isSafeInteger(item?.number)) {
        pullRequests.push({ repository: match[1], number: item.number });
      }
    }

    if (items.length < 100) {
      break;
    }
  }

  return pullRequests;
}

async function main() {
  const properties = validateProperties(await readJsonc(propertiesPath), {
    requireOrganization: true,
    requireLabelSyncTokenSecretName: false,
  });
  const config = await loadLabelTestAndCommandsConfig(workspaceRoot);

  if (!isWaitForMergeEnabled(config)) {
    console.log("waitForMerge is not configured; nothing to do.");
    return;
  }

  const token = process.env.LABEL_SYNC_TOKEN;
  assert(token, "Wait-For-Merge needs the configured PAT or GitHub App token, because it works across repositories.");

  if (process.env.DISPATCH_REPOSITORY || process.env.DISPATCH_PULL_REQUEST) {
    console.log(`Triggered by the close of ${process.env.DISPATCH_REPOSITORY || "?"}#${process.env.DISPATCH_PULL_REQUEST || "?"}.`);
  }

  const request = createStatusAwareGithubRequest(token);
  const isTeamMember = createTeamMembershipChecker(request, properties.organization);
  const isAutomationActor = createWaitForMergeActorChecker(request);
  const getPullRequestState = createPullRequestStateReader(request);
  const waiting = await findWaitingPullRequests(request, {
    organization: properties.organization,
    label: config.waitForMerge.label,
  });

  console.log(`Found ${waiting.length} open pull request(s) with the "${config.waitForMerge.label}" label.`);
  let completed = 0;
  let failed = 0;

  for (const { repository, number } of waiting) {
    try {
      const outcome = await reconcileWaitForMerge({
        request,
        config,
        repository,
        pullRequestNumber: number,
        mode: "check",
        isTeamMember,
        isAutomationActor,
        getPullRequestState,
      });

      if (outcome.labelRemoved) {
        completed += 1;
      }
    } catch (error) {
      failed += 1;
      console.log(`::warning title=Wait for merge failed::${escapeWorkflowCommand(`${repository}#${number}: ${error.message}`)}`);
    }
  }

  console.log(`Completed ${completed} wait(s).`);

  if (failed > 0) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
