import path from "node:path";
import { pathToFileURL } from "node:url";
import { assert, normalizeName, readJsonc } from "./lib/config-utils.mjs";
import { validateProperties } from "./lib/config-validation.mjs";
import { loadLabelTestAndCommandsConfig } from "./lib/load-command-config.mjs";
import { parseCommandLines, resolveCommitIdentity } from "./lib/command-utils.mjs";
import { commandRegistry, enabledCommands, runMergeCommands } from "./lib/commands.mjs";
import { createGitCherryPicker } from "./lib/git-cherry-pick.mjs";
import {
  createStatusAwareGithubRequest,
  createTeamMembershipChecker,
  createWaitForMergeActorChecker,
} from "./lib/wait-for-merge-runner.mjs";

// Handles "/" commands in pull request and issue comments. Commands arrive only as a repository_dispatch of
// type "pull-request-comment" or "issue-comment", sent to the Label Sync repository by something that watches
// the organization (for example a GitHub App's webhook handler). Nothing in the payload is trusted: the
// repository must be in the organization, and the comment is read again from the API and must be on the named
// issue or pull request, not written by a bot, and start with "/". Commands act with the configured PAT or
// GitHub App token only, so label changes start Label Test by themselves.
//
// The commands themselves are listed in scripts/lib/commands.mjs. A new comment runs every enabled command it
// contains. An edited or deleted comment only matters to commands whose state lives in their comments.

const workspaceRoot = process.cwd();
const propertiesPath = path.join(workspaceRoot, "config", "properties.jsonc");
const commentActions = ["created", "edited", "deleted"];

// A dispatched comment must belong to the issue or pull request named in the payload. issue_url is the API URL
// of the issue the comment is on (pull requests are issues too), so a payload that pairs a comment with the
// wrong one is caught here.
function commentBelongsTo(comment, repository, number) {
  const issueUrl = normalizeName(String(comment?.issue_url ?? ""));
  return issueUrl.endsWith(normalizeName(`/repos/${repository}/issues/${number}`));
}

function memoize(operation) {
  let promise = null;
  return () => {
    promise ??= operation();
    return promise;
  };
}

export async function handleLabelTestCommand({
  request,
  config,
  organization,
  repository,
  pullRequestNumber,
  commentId,
  commentAction,
  isTeamMember = createTeamMembershipChecker(request, organization),
  isAutomationActor = createWaitForMergeActorChecker(request),
  getCherryPicker = async () => {
    throw new Error("Cherry-picking is not available here.");
  },
  registry = commandRegistry,
  log = console.log,
}) {
  assert(
    typeof repository === "string" && /^[^/\s]+\/[^/\s]+$/.test(repository),
    "TARGET_REPOSITORY must match owner/repo.",
  );
  assert(/^[1-9]\d*$/.test(String(pullRequestNumber ?? "")), "PULL_REQUEST_NUMBER must be a number.");
  assert(/^[1-9]\d*$/.test(String(commentId ?? "")), "COMMENT_ID must be a number.");
  assert(commentActions.includes(commentAction), 'COMMENT_ACTION must be "created", "edited" or "deleted".');

  const skip = (reason, message) => {
    log(message);
    return { handled: false, reason, results: {} };
  };

  const enabled = enabledCommands(config, registry);

  if (enabled.length === 0) {
    return skip("disabled", "No commands are enabled in config/commands.jsonc.");
  }

  if (normalizeName(repository.split("/")[0]) !== normalizeName(organization)) {
    return skip("organization", `${repository} is not in the ${organization} organization.`);
  }

  let comment = null;
  let targets;

  if (commentAction === "deleted") {
    // A deleted comment can no longer be read, so the commands that care are reconciled without it. That can
    // update a tracking comment or finish a wait, but never start one.
    targets = enabled.filter((command) => command.handlesEditsAndDeletes);
  } else {
    try {
      comment = await request("GET", `/repos/${repository}/issues/comments/${commentId}`);
    } catch (error) {
      if (error.status === 404) {
        return skip("missing", "The comment no longer exists.");
      }
      throw error;
    }

    if (!commentBelongsTo(comment, repository, pullRequestNumber)) {
      return skip("mismatch", `Comment ${commentId} is not on ${repository}#${pullRequestNumber}.`);
    }

    if (comment?.user?.type === "Bot") {
      return skip("bot", "Comments written by bots are ignored.");
    }

    if (!String(comment?.body ?? "").startsWith("/")) {
      return skip("not-command", "The comment does not start with a command.");
    }

    const names = new Set(parseCommandLines(comment.body).map((line) => line.name));
    // An edit may have removed a command, so commands that keep state in comments always look again.
    targets = commentAction === "created"
      ? enabled.filter((command) => names.has(command.name))
      : enabled.filter((command) => command.handlesEditsAndDeletes);
  }

  if (targets.length === 0) {
    return skip("not-command", "The comment does not contain an enabled command that needs handling.");
  }

  // Read fresh, never from the payload. Commands that only work on pull requests leave issues alone.
  const issue = await request("GET", `/repos/${repository}/issues/${pullRequestNumber}`);
  const lines = comment ? parseCommandLines(comment.body) : [];
  const runMergeCommandsOnce = memoize(async () => runMergeCommands({
    request,
    config,
    repository,
    number: pullRequestNumber,
    isTeamMember,
    isAutomationActor,
    cherryPick: await getCherryPicker(),
    log,
  }));
  const results = {};
  const errors = [];

  for (const command of targets) {
    if (command.pullRequestsOnly && !issue?.pull_request) {
      log(`/${command.name} only works on pull requests; ${repository}#${pullRequestNumber} is an issue.`);
      continue;
    }

    try {
      results[command.name] = await command.run({
        request,
        config,
        organization,
        repository,
        number: pullRequestNumber,
        issue,
        comment,
        commands: lines.filter((line) => line.name === command.name),
        commentAction,
        isTeamMember,
        isAutomationActor,
        runMergeCommandsOnce,
        log,
      });
    } catch (error) {
      errors.push(`/${command.name}: ${error.message}`);
      log(`::error title=/${command.name} failed::${String(error.message).replace(/\r?\n/g, " ")}`);
    }
  }

  if (errors.length > 0) {
    throw new Error(errors.join("\n"));
  }

  return { handled: true, reason: null, results };
}

async function main() {
  const properties = validateProperties(await readJsonc(propertiesPath), {
    requireOrganization: true,
    requireLabelSyncTokenSecretName: false,
  });
  const config = await loadLabelTestAndCommandsConfig(workspaceRoot);
  const token = process.env.LABEL_SYNC_TOKEN;
  assert(token, "LABEL_SYNC_TOKEN is required: commands use the configured PAT or GitHub App token.");

  const request = createStatusAwareGithubRequest(token);

  await handleLabelTestCommand({
    request,
    config,
    organization: properties.organization,
    repository: process.env.TARGET_REPOSITORY,
    pullRequestNumber: process.env.PULL_REQUEST_NUMBER,
    commentId: process.env.COMMENT_ID,
    commentAction: process.env.COMMENT_ACTION,
    getCherryPicker: async () => createGitCherryPicker({ token, identity: await resolveCommitIdentity(request) }),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
