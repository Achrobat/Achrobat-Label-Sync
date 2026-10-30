import { normalizeName } from "./config-utils.mjs";
import { createMemberChecker } from "./command-utils.mjs";
import { planWaitForMerge, planWaitForMergeCancellation } from "./wait-for-merge.mjs";

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

// Recognizes the identity behind the configured Label Sync token ("<app-slug>[bot]" or the PAT owner). Label
// Sync never writes with GITHUB_TOKEN, so github-actions[bot] does not count: any workflow in the repository
// can post as it.
export function createWaitForMergeActorChecker(request) {
  let loginPromise = null;

  const resolveLogin = async () => {
    if (process.env.LABEL_SYNC_TOKEN_LOGIN) {
      return process.env.LABEL_SYNC_TOKEN_LOGIN;
    }

    if (!process.env.LABEL_SYNC_TOKEN) {
      return null;
    }

    try {
      const user = await request("GET", "/user");
      return typeof user?.login === "string" ? user.login : null;
    } catch {
      return null;
    }
  };

  return async (login) => {
    if (typeof login !== "string" || !login) {
      return false;
    }

    loginPromise ??= resolveLogin();
    const automationLogin = await loginPromise;
    return Boolean(automationLogin) && normalizeName(automationLogin) === normalizeName(login);
  };
}

export function createRunnerChecker(config, isTeamMember) {
  return createMemberChecker(config?.waitForMerge?.allowedUsers ?? [], isTeamMember);
}

// Linked pull requests are always read live, never from an event payload. A pull request Label Sync cannot
// read (404, 403 or 410) is reported as "unreadable" and keeps the wait going; any other failure stops the run
// so that the next run can try again.
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
          if (error.status === 404 || error.status === 403 || error.status === 410) {
            return "unreadable";
          }
          throw error;
        },
      ));
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

// Reconciles one pull request and applies the plan. Returns the pull request's labels afterwards and whether
// the label was added or removed. `issue` may be passed when the caller already holds fresh issue data.
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

  const plan = await planWaitForMerge({
    config,
    repository,
    pullRequestNumber,
    pullRequestAuthor: currentIssue?.user?.login,
    prLabels: labels,
    comments,
    labelEvents,
    mode,
    triggeringCommentId,
    isAllowedRunner: createRunnerChecker(config, isTeamMember),
    isAutomationActor,
    getPullRequestState,
  });
  outcome.plan = plan;

  if (plan.triggerRejected) {
    notice(log, "Wait for merge ignored", `${plan.triggerRejected.login} is not allowed to run the wait-for-merge command.`);

    try {
      await request("POST", `/repos/${repository}/issues/comments/${triggeringCommentId}/reactions`, { content: "-1" });
    } catch (error) {
      warn(log, "Wait for merge reaction failed", error.message);
    }

    return outcome;
  }

  const target = `${repository}#${pullRequestNumber}`;

  if (plan.readyToMergeComment) {
    await request("POST", `/repos/${repository}/issues/${pullRequestNumber}/comments`, { body: plan.readyToMergeComment.body });
    notice(log, "Wait for merge complete", `${target} is ready to merge.`);
  }

  if (plan.createTracking) {
    await request("POST", `/repos/${repository}/issues/${pullRequestNumber}/comments`, { body: plan.createTracking.body });
  }

  if (plan.updateTracking) {
    try {
      await request("PATCH", `/repos/${repository}/issues/comments/${plan.updateTracking.commentId}`, { body: plan.updateTracking.body });
    } catch (error) {
      warn(log, "Wait for merge comment update failed", error.message);
    }
  }

  if (plan.addLabel) {
    const updated = await request("POST", `/repos/${repository}/issues/${pullRequestNumber}/labels`, { labels: [config.waitForMerge.label] });
    outcome.labels = Array.isArray(updated) ? updated : [...labels, { name: config.waitForMerge.label }];
    outcome.labelAdded = true;
    notice(log, "Wait for merge started", `${target} is waiting on ${plan.dependencies.filter((dependency) => dependency.state === "open").map((dependency) => dependency.display).join(", ")}.`);
  }

  if (plan.removeLabel) {
    try {
      const updated = await request("DELETE", `/repos/${repository}/issues/${pullRequestNumber}/labels/${encodeURIComponent(plan.removeLabel)}`);
      outcome.labels = Array.isArray(updated) ? updated : labels.filter((label) => label?.name !== plan.removeLabel);
    } catch (error) {
      if (error.status !== 404) {
        throw error;
      }
      outcome.labels = labels.filter((label) => label?.name !== plan.removeLabel);
    }
    outcome.labelRemoved = true;
  }

  return outcome;
}

export async function cancelWaitForMerge({
  request,
  config,
  repository,
  pullRequestNumber,
  triggeringEvent,
  isAutomationActor,
  log = console.log,
}) {
  if (
    triggeringEvent?.action !== "unlabeled"
    || normalizeName(triggeringEvent?.label ?? "") !== normalizeName(config?.waitForMerge?.label ?? "")
  ) {
    return false;
  }

  const comments = await getAllPages(request, `/repos/${repository}/issues/${pullRequestNumber}/comments`);
  const cancellation = await planWaitForMergeCancellation({ config, comments, triggeringEvent, isAutomationActor });

  if (!cancellation) {
    return false;
  }

  await request("PATCH", `/repos/${repository}/issues/comments/${cancellation.commentId}`, { body: cancellation.body });
  notice(log, "Wait for merge cancelled", `${repository}#${pullRequestNumber}: the label was removed by ${triggeringEvent.sender || "an unknown user"}.`);
  return true;
}
