import path from "node:path";
import { pathToFileURL } from "node:url";
import { assert, readJsonc } from "./lib/config-utils.mjs";
import { validateLabelTestWorkflowConfig, validateProperties } from "./lib/config-validation.mjs";
import { isWaitForMergeEnabled, parseWaitForMergeCommands } from "./lib/wait-for-merge.mjs";
import {
  createStatusAwareGithubRequest,
  createTeamMembershipChecker,
  createWaitForMergeActorChecker,
  reconcileWaitForMerge,
} from "./lib/wait-for-merge-runner.mjs";
import { rerunLabelTestForPullRequest } from "./rerun-label-policy.mjs";

// Handles slash commands in pull request comments for the Label Test Commands caller workflow. The caller
// only starts this for comments on pull requests whose body starts with "/", written by someone who is not
// a bot. The comment body is read from the API, not from the event payload.

const workspaceRoot = process.cwd();
const propertiesPath = path.join(workspaceRoot, "config", "properties.jsonc");
const labelTestWorkflowConfigPath = path.join(workspaceRoot, "config", "label-test-workflow-config.jsonc");

function escapeWorkflowCommand(value) {
  return String(value).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

async function main() {
  const properties = validateProperties(await readJsonc(propertiesPath), {
    requireOrganization: true,
    requireLabelSyncTokenSecretName: false,
  });
  const config = validateLabelTestWorkflowConfig(await readJsonc(labelTestWorkflowConfigPath));
  const repository = process.env.TARGET_REPOSITORY;
  const pullRequestNumber = process.env.PULL_REQUEST_NUMBER;
  const commentId = process.env.COMMENT_ID;
  const commentAction = process.env.COMMENT_ACTION;
  const token = process.env.LABEL_SYNC_TOKEN ?? process.env.GITHUB_TOKEN;

  assert(token, "LABEL_SYNC_TOKEN or GITHUB_TOKEN is required.");
  assert(repository && /^[^/\s]+\/[^/\s]+$/.test(repository), "TARGET_REPOSITORY must match owner/repo.");
  assert(pullRequestNumber && /^\d+$/.test(pullRequestNumber), "PULL_REQUEST_NUMBER must be a number.");
  assert(commentId && /^\d+$/.test(commentId), "COMMENT_ID must be a number.");

  if (!isWaitForMergeEnabled(config)) {
    console.log("No Label Test commands are enabled in config/label-test-workflow-config.jsonc.");
    return;
  }

  const request = createStatusAwareGithubRequest(token);

  // A new comment without a wait-for-merge command is left alone. An edited or deleted comment is always
  // reconciled, because the edit or deletion may have removed a command. A deleted comment can no longer be
  // read, so it is reconciled without a triggering comment.
  if (commentAction === "created") {
    let comment;

    try {
      comment = await request("GET", `/repos/${repository}/issues/comments/${commentId}`);
    } catch (error) {
      if (error.status === 404) {
        console.log("The comment no longer exists.");
        return;
      }
      throw error;
    }

    if (parseWaitForMergeCommands(comment?.body).length === 0) {
      console.log("The comment does not contain a Label Test command.");
      return;
    }
  }

  const outcome = await reconcileWaitForMerge({
    request,
    config,
    repository,
    pullRequestNumber,
    mode: "command",
    triggeringCommentId: commentAction === "deleted" ? null : commentId,
    isTeamMember: createTeamMembershipChecker(request, properties.organization),
    isAutomationActor: createWaitForMergeActorChecker(request),
  });

  // A label change made with the configured PAT or GitHub App token starts Label Test by itself. One made with
  // the GITHUB_TOKEN fallback does not, so the latest Label Test run is rerun to update the required check.
  if ((outcome.labelAdded || outcome.labelRemoved) && !process.env.LABEL_SYNC_TOKEN) {
    try {
      const run = await rerunLabelTestForPullRequest({ token, repository, pullRequestNumber });
      console.log(`Reran Label Test run ${run.id} so the required check reflects the label change.`);
    } catch (error) {
      console.log(`::warning title=Label Test not rerun::${escapeWorkflowCommand(error.message)}`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
