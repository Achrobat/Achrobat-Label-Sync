import { isWaitForMergeEnabled } from "./wait-for-merge.mjs";
import { reconcileWaitForMerge } from "./wait-for-merge-runner.mjs";
import { isTeamCommandEnabled, runTeamCommands, TEAM_COMMAND } from "./team-command.mjs";
import {
  acknowledgeMergeCommand,
  CHERRY_PICK_COMMAND,
  isCherryPickEnabled,
  isReleaseEnabled,
  RELEASE_COMMAND,
  runMergeCommands,
} from "./merge-commands.mjs";

// The "/" commands Label Sync knows. Each entry says when the command is on, whether it only works on pull
// requests, and whether edits and deletions of its comments matter (true for commands whose state is worked
// out from their comments, like wait-for-merge's tracking comment). run() receives the context built by
// handleLabelTestCommand: request, config, organization, repository, number, issue, comment (null for a
// deleted comment), commands (this command's lines in the comment), commentAction, isTeamMember,
// isAutomationActor, runMergeCommandsOnce and log.
//
// Commands that are not listed here, or are turned off, are ignored without a reaction, so typos and other
// tools' commands are left alone.

async function runMergeCommand(command, context) {
  const acknowledgement = await acknowledgeMergeCommand({ ...context, command });

  // A command posted after the merge has nothing to wait for.
  if (acknowledgement.merged) {
    acknowledgement.mergeOutcome = await context.runMergeCommandsOnce();
  }

  return acknowledgement;
}

export const commandRegistry = [
  {
    name: "wait-for-merge",
    isEnabled: isWaitForMergeEnabled,
    pullRequestsOnly: true,
    handlesEditsAndDeletes: true,
    run: (context) => reconcileWaitForMerge({
      request: context.request,
      config: context.config,
      repository: context.repository,
      pullRequestNumber: context.number,
      mode: "command",
      triggeringCommentId: context.comment ? context.comment.id : null,
      issue: context.issue,
      isTeamMember: context.isTeamMember,
      isAutomationActor: context.isAutomationActor,
      log: context.log,
    }),
  },
  {
    name: CHERRY_PICK_COMMAND,
    isEnabled: isCherryPickEnabled,
    pullRequestsOnly: true,
    handlesEditsAndDeletes: false,
    run: (context) => runMergeCommand(CHERRY_PICK_COMMAND, context),
  },
  {
    name: RELEASE_COMMAND,
    isEnabled: isReleaseEnabled,
    pullRequestsOnly: true,
    handlesEditsAndDeletes: false,
    run: (context) => runMergeCommand(RELEASE_COMMAND, context),
  },
  {
    name: TEAM_COMMAND,
    isEnabled: isTeamCommandEnabled,
    pullRequestsOnly: false,
    handlesEditsAndDeletes: false,
    run: (context) => runTeamCommands(context),
  },
];

export function enabledCommands(config, registry = commandRegistry) {
  return registry.filter((command) => command.isEnabled(config));
}

export { runMergeCommands };
