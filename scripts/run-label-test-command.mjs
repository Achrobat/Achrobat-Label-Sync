import path from "node:path";
import { pathToFileURL } from "node:url";
import { assert, normalizeName, readJsonc } from "./lib/config-utils.mjs";
import { validateLabelTestWorkflowConfig, validateProperties } from "./lib/config-validation.mjs";
import { isWaitForMergeEnabled, parseWaitForMergeCommands } from "./lib/wait-for-merge.mjs";
import {
  createStatusAwareGithubRequest,
  createTeamMembershipChecker,
  createWaitForMergeActorChecker,
  reconcileWaitForMerge,
} from "./lib/wait-for-merge-runner.mjs";

// Handles slash commands in pull request comments. Commands arrive one of two ways, chosen by
// "commandDelivery" in config/label-test-workflow-config.jsonc:
// - "workflow": the Label Test Commands caller workflow in the target repository. Its job condition only
//   starts this for comments on pull requests whose body starts with "/", written by someone who is not a bot.
// - "dispatch": a "pull-request-comment" repository_dispatch sent to the Label Sync repository by something
//   that watches the organization. Nothing in the payload is trusted, so the same conditions are checked here.
// Commands that arrive the other way are ignored, so one comment is never handled twice. The comment body is
// always read from the API, not from the event payload. Both paths act with the configured PAT or GitHub App
// token only, so label changes start Label Test by themselves.

const workspaceRoot = process.cwd();
const propertiesPath = path.join(workspaceRoot, "config", "properties.jsonc");
const labelTestWorkflowConfigPath = path.join(workspaceRoot, "config", "label-test-workflow-config.jsonc");
const commentActions = ["created", "edited", "deleted"];

function describeSource(source) {
  return source === "dispatch" ? "a repository_dispatch" : "the Label Test Commands caller workflow";
}

// A dispatched comment must belong to the pull request named in the payload. issue_url is the API URL of the
// issue the comment is on, so a payload that pairs a comment with the wrong pull request is caught here.
function commentBelongsTo(comment, repository, pullRequestNumber) {
  const issueUrl = normalizeName(String(comment?.issue_url ?? ""));
  return issueUrl.endsWith(normalizeName(`/repos/${repository}/issues/${pullRequestNumber}`));
}

export async function handleLabelTestCommand({
  request,
  config,
  organization,
  source = "workflow",
  repository,
  pullRequestNumber,
  commentId,
  commentAction,
  isTeamMember = createTeamMembershipChecker(request, organization),
  isAutomationActor = createWaitForMergeActorChecker(request),
  log = console.log,
}) {
  assert(source === "workflow" || source === "dispatch", 'COMMAND_SOURCE must be "workflow" or "dispatch".');
  assert(
    typeof repository === "string" && /^[^/\s]+\/[^/\s]+$/.test(repository),
    "TARGET_REPOSITORY must match owner/repo.",
  );
  assert(/^[1-9]\d*$/.test(String(pullRequestNumber ?? "")), "PULL_REQUEST_NUMBER must be a number.");
  assert(/^[1-9]\d*$/.test(String(commentId ?? "")), "COMMENT_ID must be a number.");
  assert(commentActions.includes(commentAction), 'COMMENT_ACTION must be "created", "edited" or "deleted".');

  const skip = (reason, message) => {
    log(message);
    return { handled: false, reason, outcome: null };
  };

  if (!isWaitForMergeEnabled(config)) {
    return skip("disabled", "No Label Test commands are enabled in config/label-test-workflow-config.jsonc.");
  }

  if (config.commandDelivery !== source) {
    return skip(
      "delivery",
      `commandDelivery is "${config.commandDelivery}", so commands arriving through ${describeSource(source)} are ignored.`,
    );
  }

  if (source === "dispatch") {
    if (normalizeName(repository.split("/")[0]) !== normalizeName(organization)) {
      return skip("organization", `${repository} is not in the ${organization} organization.`);
    }
  }

  // A deleted comment can no longer be read, so it is reconciled without a triggering comment. An edited
  // comment is always reconciled, because the edit may have removed a command. A new comment without a
  // wait-for-merge command is left alone.
  if (commentAction !== "deleted") {
    let comment;

    try {
      comment = await request("GET", `/repos/${repository}/issues/comments/${commentId}`);
    } catch (error) {
      if (error.status === 404) {
        return skip("missing", "The comment no longer exists.");
      }
      throw error;
    }

    // The caller workflow's job condition makes these checks before a runner starts. A dispatch does not, so
    // they are made here against the comment as it is now.
    if (source === "dispatch") {
      if (!commentBelongsTo(comment, repository, pullRequestNumber)) {
        return skip("mismatch", `Comment ${commentId} is not on ${repository}#${pullRequestNumber}.`);
      }

      if (comment?.user?.type === "Bot") {
        return skip("bot", "Comments written by bots are ignored.");
      }

      if (!String(comment?.body ?? "").startsWith("/")) {
        return skip("not-command", "The comment does not start with a command.");
      }
    }

    if (commentAction === "created" && parseWaitForMergeCommands(comment?.body).length === 0) {
      return skip("not-command", "The comment does not contain a Label Test command.");
    }
  }

  // reconcileWaitForMerge reads the issue again and leaves anything that is not an open pull request alone, so
  // a dispatch that names an issue or a closed pull request changes nothing.
  const outcome = await reconcileWaitForMerge({
    request,
    config,
    repository,
    pullRequestNumber,
    mode: "command",
    triggeringCommentId: commentAction === "deleted" ? null : commentId,
    isTeamMember,
    isAutomationActor,
    log,
  });

  return { handled: true, reason: null, outcome };
}

async function main() {
  const properties = validateProperties(await readJsonc(propertiesPath), {
    requireOrganization: true,
    requireLabelSyncTokenSecretName: false,
  });
  const config = validateLabelTestWorkflowConfig(await readJsonc(labelTestWorkflowConfigPath));
  const token = process.env.LABEL_SYNC_TOKEN;
  assert(token, "LABEL_SYNC_TOKEN is required: commands use the configured PAT or GitHub App token.");

  const request = createStatusAwareGithubRequest(token);

  await handleLabelTestCommand({
    request,
    config,
    organization: properties.organization,
    source: process.env.COMMAND_SOURCE || "workflow",
    repository: process.env.TARGET_REPOSITORY,
    pullRequestNumber: process.env.PULL_REQUEST_NUMBER,
    commentId: process.env.COMMENT_ID,
    commentAction: process.env.COMMENT_ACTION,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
