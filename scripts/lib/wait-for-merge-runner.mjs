import { normalizeName } from "./config-utils.mjs";
import { createMemberChecker } from "./command-utils.mjs";
import { planWaitForMerge, readActiveWaitLinks } from "./wait-for-merge.mjs";

// GitHub API helpers for the wait-for-merge command. Every helper takes a request(method, apiPath, body)
// function that resolves with the parsed JSON (null for 204) and rejects with an Error carrying `status`, so
// the Label Test script, the command script and the central workflow can share them with their own clients.

export function createStatusAwareGithubRequest(token, { userAgent = "label-sync-wait-for-merge" } = {}) {
  return async (method, apiPath, body) => {
    const response = await fetch(`https://api.github.com${apiPath}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "User-Agent": userAgent,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const message = await response.text();
      const error = new Error(`${method} ${apiPath} failed with ${response.status}: ${message}`);
      error.status = response.status;
      throw error;
    }

    return response.status === 204 ? null : response.json();
  };
}

export async function getAllPages(request, apiPath) {
  const results = [];

  for (let page = 1; ; page += 1) {
    const separator = apiPath.includes("?") ? "&" : "?";
    const batch = await request("GET", `${apiPath}${separator}per_page=100&page=${page}`);
    const items = Array.isArray(batch) ? batch : [];
    results.push(...items);

    if (items.length < 100) {
      return results;
    }
  }
}

export function createTeamMembershipChecker(request, organization) {
  const cache = new Map();

  return async (teamSlug, login) => {
    const key = `${normalizeName(teamSlug)}\0${normalizeName(login)}`;

    if (!cache.has(key)) {
      cache.set(key, request(
        "GET",
        `/orgs/${encodeURIComponent(organization)}/teams/${encodeURIComponent(teamSlug)}/memberships/${encodeURIComponent(login)}`,
      ).then(
        (membership) => membership?.state === "active",
        (error) => {
          if (error.status === 404) {
            return false;
          }
          throw error;
        },
      ));
    }

    return cache.get(key);
  };
}

// Recognizes the identity behind the GitHub App token ("<app-slug>[bot]", from LABEL_SYNC_TOKEN_LOGIN). Commands
// only work with GitHub App authentication, because telling Label Sync's own label changes apart from a
// person's needs an identity nobody else acts as. github-actions[bot] never counts: any workflow in the
// repository can post as it.
export function createWaitForMergeActorChecker() {
  const automationLogin = process.env.LABEL_SYNC_TOKEN_LOGIN || null;

  return async (login) => (
    typeof login === "string"
    && Boolean(login)
    && Boolean(automationLogin)
    && normalizeName(automationLogin) === normalizeName(login)
  );
}

export function createRunnerChecker(config, isTeamMember) {
  return createMemberChecker(config?.waitForMerge?.allowedUsers ?? [], isTeamMember);
}

// Linked pull requests are always read live, never from an event payload. A pull request that does not exist
// (404 or 410) is "missing", which makes the link invalid. One Label Sync may not read (403) is "unreadable"
// and keeps counting as open. Any other failure stops the run so that the next run can try again.
export function createPullRequestStateReader(request) {
  const cache = new Map();

  return async (reference) => {
    const key = normalizeName(`${reference.owner}/${reference.repo}#${reference.number}`);

    if (!cache.has(key)) {
      cache.set(key, request(
        "GET",
        `/repos/${encodeURIComponent(reference.owner)}/${encodeURIComponent(reference.repo)}/pulls/${reference.number}`,
      ).then(
        (pullRequest) => {
          if (pullRequest?.merged_at || pullRequest?.merged === true) {
            return "merged";
          }
          return pullRequest?.state === "closed" ? "closed" : "open";
        },
        (error) => {
          if (error.status === 404 || error.status === 410) {
            return "missing";
          }
          if (error.status === 403) {
            return "unreadable";
          }
          throw error;
        },
      ));
    }

    return cache.get(key);
  };
}

const WRITE_PERMISSIONS = new Set(["admin", "maintain", "write"]);

// A pull request is approved when at least one person with write access (write, maintain or admin) has
// approved it and has not since requested changes or had the approval dismissed. Nothing else counts.
export async function isPullRequestApproved(request, repository, number) {
  const reviews = await getAllPages(request, `/repos/${repository}/pulls/${number}/reviews`);
  const latest = new Map();

  for (const review of reviews) {
    const login = review?.user?.login;

    if (typeof login === "string" && ["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(review.state)) {
      latest.set(normalizeName(login), { login, state: review.state });
    }
  }

  for (const { login, state } of latest.values()) {
    if (state !== "APPROVED") {
      continue;
    }

    try {
      const permission = await request("GET", `/repos/${repository}/collaborators/${encodeURIComponent(login)}/permission`);

      if (WRITE_PERMISSIONS.has(permission?.role_name) || WRITE_PERMISSIONS.has(permission?.permission)) {
        return true;
      }
    } catch (error) {
      if (error.status !== 404) {
        throw error;
      }
    }
  }

  return false;
}

// For the loop check: reads what another pull request is waiting on right now. Pull requests that can't be
// read, are closed or don't have the label are waiting on nothing. The loop check is a safety net, so a failed
// lookup is logged and counts as waiting on nothing instead of failing the command.
export function createActiveWaitLinkFinder({ request, config, isAllowedRunner, isAutomationActor, log = console.log }) {
  const cache = new Map();

  return async (reference) => {
    const repository = `${reference.owner}/${reference.repo}`;
    const key = normalizeName(`${repository}#${reference.number}`);

    if (!cache.has(key)) {
      cache.set(key, (async () => {
        let issue;

        try {
          issue = await request("GET", `/repos/${repository}/issues/${reference.number}`);
        } catch (error) {
          if ([403, 404, 410].includes(error.status)) {
            return [];
          }
          throw error;
        }

        if (!issue?.pull_request || issue.state !== "open") {
          return [];
        }

        const labels = Array.isArray(issue.labels) ? issue.labels : [];
        const labelKey = normalizeName(config.waitForMerge.label);

        if (!labels.some((label) => normalizeName(label?.name ?? "") === labelKey)) {
          return [];
        }

        const [comments, labelEvents] = await Promise.all([
          getAllPages(request, `/repos/${repository}/issues/${reference.number}/comments`),
          getAllPages(request, `/repos/${repository}/issues/${reference.number}/events`),
        ]);

        return readActiveWaitLinks({ config, repository, labels, comments, labelEvents, isAllowedRunner, isAutomationActor });
      })().catch((error) => {
        warn(log, "Wait for merge loop check incomplete", `${repository}#${reference.number}: ${error.message}`);
        return [];
      }));
    }

    return cache.get(key);
  };
}

function escapeWorkflowCommand(value) {
  return String(value).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

function warn(log, title, message) {
  log(`::warning title=${title}::${escapeWorkflowCommand(message)}`);
}

function notice(log, title, message) {
  log(`::notice title=${title}::${escapeWorkflowCommand(message)}`);
}

// Makes Label Sync's own 👍/👎 on a comment match `content`, removing the other one if it is there. Reactions
// are acknowledgements only, so a failure is logged and never stops the run.
export async function syncReaction({ request, repository, commentId, content, isAutomationActor, log = console.log }) {
  try {
    const reactions = await getAllPages(request, `/repos/${repository}/issues/comments/${commentId}/reactions`);
    let present = false;

    for (const reaction of reactions) {
      if (!["+1", "-1"].includes(reaction?.content) || !(await isAutomationActor(reaction?.user?.login))) {
        continue;
      }

      if (reaction.content === content) {
        present = true;
      } else {
        await request("DELETE", `/repos/${repository}/issues/comments/${commentId}/reactions/${reaction.id}`);
      }
    }

    if (!present) {
      await request("POST", `/repos/${repository}/issues/comments/${commentId}/reactions`, { content });
    }
  } catch (error) {
    warn(log, "Wait for merge reaction failed", error.message);
  }
}

// GitHub has no conflict check for comment edits, so each comment is read again right before it is written.
// If someone changed it since this run read it, the edit is skipped: their edit starts its own run.
async function applyCommentEdit({ request, repository, edit, log }) {
  let current;

  try {
    current = await request("GET", `/repos/${repository}/issues/comments/${edit.commentId}`);
  } catch (error) {
    if (error.status === 404) {
      return false;
    }
    throw error;
  }

  if (current?.body !== edit.from) {
    notice(log, "Wait for merge comment changed", `Comment ${edit.commentId} changed during this run, so it was left for the next run.`);
    return false;
  }

  await request("PATCH", `/repos/${repository}/issues/comments/${edit.commentId}`, { body: edit.to });
  return true;
}

// Reconciles one pull request and applies the plan. Returns the pull request's labels afterwards and whether
// the label was added or removed. `issue` may be passed when the caller already holds fresh issue data.
//
// Order matters, because Label Test runs on every label change and reconciles too: the ready-to-merge comment
// first (so a retry can't post it twice), then the comment edits (so a newly accepted command is marked
// waiting before its label appears), then reactions, then the label.
export async function reconcileWaitForMerge({
  request,
  config,
  repository,
  pullRequestNumber,
  mode = "check",
  triggeringCommentId = null,
  issue = null,
  loadIssueEvents = null,
  isTeamMember,
  isAutomationActor,
  getPullRequestState = createPullRequestStateReader(request),
  isApproved = () => isPullRequestApproved(request, repository, pullRequestNumber),
  log = console.log,
}) {
  const currentIssue = issue ?? await request("GET", `/repos/${repository}/issues/${pullRequestNumber}`);
  const labels = Array.isArray(currentIssue?.labels) ? currentIssue.labels : [];
  const outcome = { labels, labelAdded: false, labelRemoved: false, plan: null };

  if (!currentIssue?.pull_request || currentIssue.state !== "open") {
    return outcome;
  }

  const [comments, labelEvents] = await Promise.all([
    getAllPages(request, `/repos/${repository}/issues/${pullRequestNumber}/comments`),
    loadIssueEvents ? loadIssueEvents() : getAllPages(request, `/repos/${repository}/issues/${pullRequestNumber}/events`),
  ]);
  const isAllowedRunner = createRunnerChecker(config, isTeamMember);

  const plan = await planWaitForMerge({
    config,
    repository,
    pullRequestNumber,
    prLabels: labels,
    comments,
    labelEvents,
    mode,
    triggeringCommentId,
    isAllowedRunner,
    isAutomationActor,
    getPullRequestState,
    isApproved,
    findActiveWaitLinks: createActiveWaitLinkFinder({ request, config, isAllowedRunner, isAutomationActor, log }),
  });
  outcome.plan = plan;
  const target = `${repository}#${pullRequestNumber}`;

  if (plan.triggerRejected) {
    notice(log, "Wait for merge ignored", `${plan.triggerRejected.login} is not allowed to run the wait-for-merge command.`);
    await syncReaction({ request, repository, commentId: triggeringCommentId, content: "-1", isAutomationActor, log });
    return outcome;
  }

  if (plan.readyToMergeComment) {
    await request("POST", `/repos/${repository}/issues/${pullRequestNumber}/comments`, { body: plan.readyToMergeComment.body });
    notice(log, "Wait for merge complete", `${target} is ready to merge.`);
  }

  for (const edit of plan.commentEdits) {
    const applied = await applyCommentEdit({ request, repository, edit, log });

    // The command that triggered this run changed under it, so its newer version decides instead.
    if (!applied && edit.triggering) {
      return outcome;
    }
  }

  for (const reaction of plan.reactions) {
    await syncReaction({ request, repository, commentId: reaction.commentId, content: reaction.content, isAutomationActor, log });
  }

  let currentLabels = labels;

  if (plan.removeLabel) {
    try {
      const updated = await request("DELETE", `/repos/${repository}/issues/${pullRequestNumber}/labels/${encodeURIComponent(plan.removeLabel)}`);
      currentLabels = Array.isArray(updated) ? updated : labels.filter((label) => label?.name !== plan.removeLabel);
    } catch (error) {
      if (error.status !== 404) {
        throw error;
      }
      currentLabels = labels.filter((label) => label?.name !== plan.removeLabel);
    }
    outcome.labelRemoved = true;
  }

  if (plan.addLabel) {
    const updated = await request("POST", `/repos/${repository}/issues/${pullRequestNumber}/labels`, { labels: [config.waitForMerge.label] });
    currentLabels = Array.isArray(updated) ? updated : [...currentLabels, { name: config.waitForMerge.label }];
    outcome.labelAdded = true;
    notice(log, "Wait for merge started", `${target} is waiting on ${plan.dependencies.filter((dependency) => dependency.state === "open" || dependency.state === "unreadable").map((dependency) => dependency.display).join(", ")}.`);
  }

  outcome.labels = currentLabels;
  return outcome;
}
