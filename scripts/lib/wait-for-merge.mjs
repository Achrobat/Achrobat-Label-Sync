import { normalizeName } from "./config-utils.mjs";

// The wait-for-merge command keeps a configured label on a pull request until every pull request linked with
// the command is merged or closed. Nothing is stored outside the pull request: every run works the state out
// again from the pull request's comments, its label history and the live state of the linked pull requests,
// so reruns, retries and replayed event payloads all reach the same answer.
//
// A "wait" lasts from the latest removal of the label until the label is removed again, either by Label Sync
// when the wait completes or by anyone else, which cancels it. Only commands posted inside the current wait
// count, so removing the label drops every earlier command, and a new command starts a fresh wait.

export const WAIT_FOR_MERGE_HEADING = "**Wait for merge**";
const READY_TO_MERGE_PHRASE = "This pull request is ready to merge";
const COMMAND_PATTERN = /^\s*\/wait-for-merge(?=\s|$)(.*)$/i;
const MAX_ECHOED_ARGUMENT_LENGTH = 100;

const STATUS = {
  waiting: "⏳ Waiting",
  idle: "⏸️ Nothing left to wait for",
  notWaiting: "💤 Not waiting",
  done: "✅ Done",
  cancelled: "🚫 Cancelled",
};

const DEPENDENCY_STATES = {
  open: { icon: "⏳", text: "open" },
  merged: { icon: "✅", text: "merged" },
  closed: { icon: "⚠️", text: "closed without merging" },
  unreadable: { icon: "❔", text: "Label Sync can't read this pull request, so it still counts as open" },
};

export function isWaitForMergeEnabled(config) {
  return Boolean(config?.waitForMerge?.label);
}

// Commands must start the comment. Every line of that comment that starts with the command is read, so one
// comment can wait on several pull requests. Returns the raw argument of each command ("" when it has none).
export function parseWaitForMergeCommands(body) {
  if (typeof body !== "string" || !body.trimStart().startsWith("/")) {
    return [];
  }

  const commandArguments = [];

  for (const line of body.split(/\r?\n/)) {
    const match = COMMAND_PATTERN.exec(line);

    if (match) {
      commandArguments.push(match[1].trim().split(/\s+/)[0] ?? "");
    }
  }

  return commandArguments;
}

// Accepts a pull request URL, "owner/repo#123", or "#123" for a pull request in the same repository.
export function parsePullRequestReference(argument, repository) {
  const value = String(argument ?? "").trim().replace(/^<(.*)>$/, "$1");

  if (!value) {
    return { error: "no pull request link was given" };
  }

  let match = /^https?:\/\/[^/\s]+\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)(?:[/?#]\S*)?$/i.exec(value)
    ?? /^([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9._-]+)#(\d+)$/.exec(value);

  if (!match) {
    const shortMatch = /^#(\d+)$/.exec(value);
    const [owner, repo] = String(repository ?? "").split("/");

    if (shortMatch && owner && repo) {
      match = [value, owner, repo, shortMatch[1]];
    }
  }

  if (!match) {
    return { error: "not a pull request link" };
  }

  const number = Number(match[3]);

  if (!Number.isSafeInteger(number) || number <= 0) {
    return { error: "not a pull request link" };
  }

  return {
    owner: match[1],
    repo: match[2],
    number,
  };
}

export function formatPullRequestReference(reference) {
  return `${reference.owner}/${reference.repo}#${reference.number}`;
}

function referenceKey(reference) {
  return normalizeName(formatPullRequestReference(reference));
}

function repositoryOwner(repository) {
  return normalizeName(String(repository ?? "").split("/")[0] ?? "");
}

function timeOf(value) {
  const time = Date.parse(value ?? "");
  return Number.isNaN(time) ? 0 : time;
}

function numericId(value) {
  return Number.isFinite(value) ? value : 0;
}

function byCreation(left, right) {
  return timeOf(left?.created_at) - timeOf(right?.created_at) || numericId(left?.id) - numericId(right?.id);
}

// The latest removal of the label starts the current wait.
function latestUnlabeledTime(labelEvents, labelKey) {
  let latest = 0;

  for (const event of labelEvents ?? []) {
    if (
      event?.event === "unlabeled"
      && typeof event.label?.name === "string"
      && normalizeName(event.label.name) === labelKey
    ) {
      latest = Math.max(latest, timeOf(event.created_at));
    }
  }

  return latest;
}

function isBotUser(user) {
  return user?.type === "Bot" || /\[bot\]$/i.test(user?.login ?? "");
}

function isTrackingBody(body) {
  return typeof body === "string" && body.startsWith(WAIT_FOR_MERGE_HEADING);
}

function isReadyToMergeBody(body) {
  return typeof body === "string" && body.includes(READY_TO_MERGE_PHRASE);
}

export function trackingCommentStatus(body) {
  if (!isTrackingBody(body)) {
    return null;
  }

  const firstLine = body.split("\n", 1)[0];

  for (const [key, text] of Object.entries(STATUS)) {
    if (firstLine.includes(text)) {
      return key;
    }
  }

  return null;
}

// User text is echoed inside a code span so it can never mention anyone or render as markdown.
function echoArgument(text) {
  const cleaned = String(text ?? "").replace(/[`\r\n]/g, "");
  const shortened = cleaned.length > MAX_ECHOED_ARGUMENT_LENGTH
    ? `${cleaned.slice(0, MAX_ECHOED_ARGUMENT_LENGTH)}…`
    : cleaned;
  return shortened ? `\`${shortened}\`` : "(no link)";
}

function joinNames(names) {
  return names.join(", ");
}

function pluralize(count, word) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function renderTrackingBody({ status, label, dependencies, rejected, pendingCount }) {
  const heading = status === "waiting"
    ? `${WAIT_FOR_MERGE_HEADING} · ${STATUS.waiting} on ${pluralize(pendingCount, "pull request")}`
    : `${WAIT_FOR_MERGE_HEADING} · ${STATUS[status]}`;
  const lines = [
    ...dependencies.map((dependency) => {
      const state = DEPENDENCY_STATES[dependency.state];
      return `- ${state.icon} ${dependency.display}: ${state.text} (requested by ${joinNames(dependency.runners)})`;
    }),
    ...rejected.map((entry) => `- ❌ ${echoArgument(entry.argument)}: ${entry.reason}, so it is ignored (requested by ${entry.runner})`),
  ];
  const footers = {
    waiting: `This pull request keeps the **${label}** label, which blocks merging, until every pull request above is merged or closed. Removing the label cancels the wait.`,
    idle: `None of the links above can be waited on. Remove the **${label}** label to unblock this pull request.`,
    notWaiting: `The **${label}** label was not added because none of the linked pull requests are open.`,
    done: `Every pull request above is merged or closed, so the **${label}** label was removed.`,
  };

  return [heading, ...(lines.length > 0 ? [lines.join("\n")] : []), footers[status]].join("\n\n");
}

function renderReadyToMergeBody({ mentions, dependencies, label }) {
  const mentionText = mentions.map((login) => `@${login}`).join(" ");
  const lines = dependencies.map((dependency) => (dependency.state === "merged"
    ? `- ✅ ${dependency.display} was merged`
    : `- ⚠️ ${dependency.display} was closed without merging`));

  return [
    `${mentionText ? `${mentionText} ` : ""}${READY_TO_MERGE_PHRASE}: every pull request it was waiting on is now merged or closed.`,
    lines.join("\n"),
    `The **${label}** label has been removed.`,
  ].join("\n\n");
}

// Plans one reconcile of a pull request.
//
// mode "command" runs for a comment that was just created, edited or deleted. It is the only mode that adds
// the label or creates the tracking comment, and it adds the label only when the triggering comment links an
// open pull request. mode "check" (Label Test runs and the central Wait-For-Merge workflow) never adds the
// label or creates a comment other than the ready-to-merge notice; it updates the tracking comment and
// completes the wait once the label is present and every linked pull request is merged or closed.
export async function planWaitForMerge({
  config,
  repository,
  pullRequestNumber,
  pullRequestAuthor,
  prLabels,
  comments,
  labelEvents,
  mode = "check",
  triggeringCommentId = null,
  isAllowedRunner,
  isAutomationActor,
  getPullRequestState,
}) {
  const settings = config?.waitForMerge;
  const plan = {
    enabled: Boolean(settings?.label),
    triggerRejected: null,
    trackingComment: null,
    createTracking: null,
    updateTracking: null,
    addLabel: false,
    removeLabel: null,
    readyToMergeComment: null,
    dependencies: [],
    rejected: [],
  };

  if (!plan.enabled) {
    return plan;
  }

  const labelKey = normalizeName(settings.label);
  const presentLabel = (prLabels ?? []).find((label) => normalizeName(label?.name ?? "") === labelKey);
  const windowStart = latestUnlabeledTime(labelEvents, labelKey);
  const ownRepositoryOwner = repositoryOwner(repository);
  const ownKey = normalizeName(`${repository}#${pullRequestNumber}`);
  const dependencies = new Map();
  const rejected = [];
  const runners = [];
  let readyToMergePosted = false;
  let triggeringHadCommands = false;

  for (const comment of [...(comments ?? [])].sort(byCreation)) {
    const login = comment?.user?.login;

    if (typeof comment?.body !== "string" || typeof login !== "string" || timeOf(comment.created_at) < windowStart) {
      continue;
    }

    if (isTrackingBody(comment.body) && await isAutomationActor(login)) {
      plan.trackingComment = comment;
      continue;
    }

    if (isReadyToMergeBody(comment.body) && await isAutomationActor(login)) {
      readyToMergePosted = true;
      continue;
    }

    const commandArguments = parseWaitForMergeCommands(comment.body);

    if (commandArguments.length === 0 || isBotUser(comment.user)) {
      continue;
    }

    const isTriggering = triggeringCommentId !== null && String(comment.id) === String(triggeringCommentId);

    if (!(await isAllowedRunner(login))) {
      if (isTriggering) {
        plan.triggerRejected = { reason: "not-allowed", login };
      }
      continue;
    }

    if (isTriggering) {
      triggeringHadCommands = true;
    }

    if (!runners.some((runner) => normalizeName(runner) === normalizeName(login))) {
      runners.push(login);
    }

    for (const argument of commandArguments) {
      const reference = parsePullRequestReference(argument, repository);
      let reason = reference.error ?? null;

      if (!reason && referenceKey(reference) === ownKey) {
        reason = "links to this pull request";
      } else if (
        !reason
        && !settings.allowExternalRepositories
        && normalizeName(reference.owner) !== ownRepositoryOwner
      ) {
        reason = "is outside this organization";
      }

      if (reason) {
        rejected.push({ argument, reason, runner: login });
        continue;
      }

      const key = referenceKey(reference);
      const existing = dependencies.get(key);

      if (existing) {
        if (!existing.runners.some((runner) => normalizeName(runner) === normalizeName(login))) {
          existing.runners.push(login);
        }
        existing.commentIds.add(String(comment.id));
        continue;
      }

      dependencies.set(key, {
        reference,
        display: formatPullRequestReference(reference),
        runners: [login],
        commentIds: new Set([String(comment.id)]),
        state: null,
      });
    }
  }

  if (plan.triggerRejected) {
    return plan;
  }

  for (const dependency of dependencies.values()) {
    dependency.state = await getPullRequestState(dependency.reference);
  }

  plan.dependencies = [...dependencies.values()];
  plan.rejected = rejected;

  const pendingCount = plan.dependencies.filter((dependency) => dependency.state === "open" || dependency.state === "unreadable").length;
  const triggeringHasOpen = plan.dependencies.some((dependency) => (
    dependency.state === "open" && dependency.commentIds.has(String(triggeringCommentId))
  ));
  const complete = Boolean(presentLabel) && plan.dependencies.length > 0 && pendingCount === 0;

  plan.addLabel = mode === "command" && !presentLabel && triggeringHasOpen;
  plan.removeLabel = complete ? presentLabel.name : null;

  const labelWillBePresent = Boolean(presentLabel) || plan.addLabel;
  let status;

  if (complete) {
    status = "done";
  } else if (labelWillBePresent && pendingCount > 0) {
    status = "waiting";
  } else if (labelWillBePresent) {
    status = "idle";
  } else {
    status = "notWaiting";
  }

  const hasEntries = plan.dependencies.length > 0 || rejected.length > 0;
  const body = renderTrackingBody({
    status,
    label: presentLabel?.name ?? settings.label,
    dependencies: plan.dependencies,
    rejected,
    pendingCount,
  });

  if (plan.trackingComment) {
    if (plan.trackingComment.body !== body) {
      plan.updateTracking = { commentId: plan.trackingComment.id, body };
    }
  } else if (mode === "command" && triggeringHadCommands && hasEntries) {
    plan.createTracking = { body };
  }

  if (complete && !readyToMergePosted) {
    const mentions = [];

    for (const login of [pullRequestAuthor, ...runners]) {
      if (
        typeof login === "string"
        && login
        && !/\[bot\]$/i.test(login)
        && !mentions.some((mention) => normalizeName(mention) === normalizeName(login))
      ) {
        mentions.push(login);
      }
    }

    plan.readyToMergeComment = {
      body: renderReadyToMergeBody({ mentions, dependencies: plan.dependencies, label: presentLabel.name }),
    };
  }

  return plan;
}

// When someone other than Label Sync removes the label, the wait is cancelled. The newest tracking comment is
// rewritten to say so, if it still describes an active wait. Nothing else needs to change: later runs ignore
// every command posted before the removal.
export async function planWaitForMergeCancellation({ config, comments, triggeringEvent, isAutomationActor }) {
  const settings = config?.waitForMerge;

  if (
    !settings?.label
    || triggeringEvent?.action !== "unlabeled"
    || typeof triggeringEvent.label !== "string"
    || normalizeName(triggeringEvent.label) !== normalizeName(settings.label)
  ) {
    return null;
  }

  const removedBy = triggeringEvent.sender || null;

  if (removedBy && await isAutomationActor(removedBy)) {
    return null;
  }

  let tracking = null;

  for (const comment of [...(comments ?? [])].sort(byCreation)) {
    if (isTrackingBody(comment?.body) && await isAutomationActor(comment?.user?.login ?? "")) {
      tracking = comment;
    }
  }

  const status = trackingCommentStatus(tracking?.body);

  if (status !== "waiting" && status !== "idle") {
    return null;
  }

  const parts = tracking.body.split("\n\n");
  const footer = `The **${triggeringEvent.label}** label was removed${removedBy ? ` by ${removedBy}` : ""}, so this wait was cancelled. Run the command again to start a new one.`;
  const body = [
    `${WAIT_FOR_MERGE_HEADING} · ${STATUS.cancelled}`,
    ...parts.slice(1, -1),
    footer,
  ].join("\n\n");

  return { commentId: tracking.id, body };
}
