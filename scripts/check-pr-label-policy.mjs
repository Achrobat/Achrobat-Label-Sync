import path from "node:path";
import { pathToFileURL } from "node:url";
import { assert, normalizeName, readJsonc } from "./lib/config-utils.mjs";
import {
  validateLabelTestWorkflowConfig,
  validateProperties,
} from "./lib/config-validation.mjs";
import {
  buildStickyLabelComment,
  evaluatePrLabelTest,
  findStickyLabelsToRestore,
  formatStickyRestoration,
  isIgnoredPullRequestAuthor,
} from "./lib/label-test-workflow.mjs";

const workspaceRoot = process.cwd();
const propertiesPath = path.join(workspaceRoot, "config", "properties.jsonc");
const labelTestWorkflowConfigPath = path.join(workspaceRoot, "config", "label-test-workflow-config.jsonc");
const validateOnly = process.argv.includes("--validate-only");

async function githubRequest(token, method, apiPath, body, { allowNotFound = false } = {}) {
  const response = await fetch(`https://api.github.com${apiPath}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "label-sync-pr-label-test",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (allowNotFound && response.status === 404) {
    return null;
  }

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`${method} ${apiPath} failed with ${response.status}: ${message}`);
  }

  if (response.status === 204) {
    return null;
  }

  return response.json();
}

async function getAllPages(token, apiPath) {
  const results = [];
  let page = 1;

  while (true) {
    const separator = apiPath.includes("?") ? "&" : "?";
    const batch = await githubRequest(token, "GET", `${apiPath}${separator}per_page=100&page=${page}`);
    results.push(...batch);

    if (batch.length < 100) {
      return results;
    }

    page += 1;
  }
}

async function getPullRequestIssue(token, repository, pullRequestNumber) {
  return githubRequest(token, "GET", `/repos/${repository}/issues/${pullRequestNumber}`);
}

async function getPullRequestIssueEvents(token, repository, pullRequestNumber) {
  return getAllPages(token, `/repos/${repository}/issues/${pullRequestNumber}/events`);
}

async function addPullRequestLabels(token, repository, pullRequestNumber, labels) {
  return githubRequest(token, "POST", `/repos/${repository}/issues/${pullRequestNumber}/labels`, { labels });
}

async function getPullRequestComments(token, repository, pullRequestNumber) {
  return getAllPages(token, `/repos/${repository}/issues/${pullRequestNumber}/comments`);
}

async function createPullRequestComment(token, repository, pullRequestNumber, body) {
  return githubRequest(token, "POST", `/repos/${repository}/issues/${pullRequestNumber}/comments`, { body });
}

// Recognizes the identity behind the configured Label Sync token: "<app-slug>[bot]" for a GitHub App
// (resolved by create-github-auth-token.mjs) or the PAT owner's login. Workflows that use this token,
// such as Remove-Labels, can only be run by Label Sync admins, so their label removals are trusted.
function createAutomationActorChecker(token) {
  let loginPromise = null;

  const resolveLogin = async () => {
    if (process.env.LABEL_SYNC_TOKEN_LOGIN) {
      return process.env.LABEL_SYNC_TOKEN_LOGIN;
    }

    if (!process.env.LABEL_SYNC_TOKEN) {
      return null;
    }

    try {
      const user = await githubRequest(token, "GET", "/user");
      return typeof user?.login === "string" ? user.login : null;
    } catch {
      return null;
    }
  };

  return async (login) => {
    loginPromise ??= resolveLogin();
    const automationLogin = await loginPromise;
    return Boolean(automationLogin) && normalizeName(automationLogin) === normalizeName(login);
  };
}

// Posts the sticky label notice once per label per pull request. The notice is informational, so a
// failure here is reported as a warning and does not change the Label Test result.
async function announceStickyLabels({ token, targetRepository, pullRequestNumber, restorations }) {
  try {
    const comments = await getPullRequestComments(token, targetRepository, pullRequestNumber);
    const body = buildStickyLabelComment(restorations, comments);

    if (body !== null) {
      await createPullRequestComment(token, targetRepository, pullRequestNumber, body);
    }
  } catch (error) {
    console.log(`::warning title=Sticky label comment failed::${escapeWorkflowCommand(error.message)}`);
  }
}

function readTriggeringLabelEvent() {
  const action = process.env.LABEL_EVENT_ACTION;

  if (!action) {
    return null;
  }

  return {
    action,
    label: process.env.LABEL_EVENT_LABEL || null,
    sender: process.env.LABEL_EVENT_SENDER || null,
  };
}

function escapeWorkflowCommand(value) {
  return value.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

// Re-applies sticky labels that were removed by someone who is not a configured remover or the Label
// Sync automation identity. This runs
// before the policy evaluation so the restored labels count toward protected-approval and failing rules
// in the same run, which keeps the required check failing instead of briefly passing.
async function restoreStickyLabels({
  token,
  config,
  targetRepository,
  pullRequestNumber,
  pullRequestIssue,
  labels,
  isTeamMember,
}) {
  if (config.stickyLabels.length === 0 || isIgnoredPullRequestAuthor(config, pullRequestIssue?.user?.login)) {
    return labels;
  }

  const present = new Set(labels.map((label) => normalizeName(label?.name ?? "")));
  const anyStickyMissing = config.stickyLabels.some((entry) => !present.has(normalizeName(entry.label)));

  if (!anyStickyMissing) {
    return labels;
  }

  const labelEvents = await getPullRequestIssueEvents(token, targetRepository, pullRequestNumber);
  const restorations = await findStickyLabelsToRestore({
    config,
    prLabels: labels,
    labelEvents,
    triggeringEvent: readTriggeringLabelEvent(),
    isTeamMember,
    isAutomationActor: createAutomationActorChecker(token),
  });

  if (restorations.length === 0) {
    return labels;
  }

  const updatedLabels = await addPullRequestLabels(
    token,
    targetRepository,
    pullRequestNumber,
    restorations.map((restoration) => restoration.label),
  );

  for (const restoration of restorations) {
    const message = formatStickyRestoration(restoration);
    console.log(`::warning title=Sticky label restored::${escapeWorkflowCommand(message)}`);
  }

  if (config.stickyLabelComment) {
    await announceStickyLabels({ token, targetRepository, pullRequestNumber, restorations });
  }

  return Array.isArray(updatedLabels) ? updatedLabels : labels;
}

async function getPullRequestReviews(token, repository, pullRequestNumber) {
  return getAllPages(token, `/repos/${repository}/pulls/${pullRequestNumber}/reviews`);
}

function createTeamMembershipChecker(token, orgName) {
  const cache = new Map();

  return async (teamSlug, login) => {
    const key = `${teamSlug}\0${login.toLowerCase()}`;

    if (cache.has(key)) {
      return cache.get(key);
    }

    const membership = await githubRequest(
      token,
      "GET",
      `/orgs/${orgName}/teams/${encodeURIComponent(teamSlug)}/memberships/${encodeURIComponent(login)}`,
      null,
      { allowNotFound: true },
    );
    const isMember = membership?.state === "active";
    cache.set(key, isMember);
    return isMember;
  };
}

function printEvaluation(result) {
  if (result.passed) {
    console.log("Label Test passed.");
    return;
  }

  console.error("Label Test failed:");

  for (const failure of result.failures) {
    console.error(`- ${failure}`);
  }
}

async function main() {
  const properties = validateProperties(await readJsonc(propertiesPath), {
    requireOrganization: true,
    requireLabelSyncTokenSecretName: false,
  });
  const config = validateLabelTestWorkflowConfig(await readJsonc(labelTestWorkflowConfigPath));

  if (validateOnly) {
    console.log("Label Test workflow configuration is valid.");
    return;
  }

  const token = process.env.LABEL_SYNC_TOKEN ?? process.env.GITHUB_TOKEN;
  const targetRepository = process.env.TARGET_REPOSITORY;
  const pullRequestNumber = process.env.PULL_REQUEST_NUMBER;

  assert(token, "LABEL_SYNC_TOKEN or GITHUB_TOKEN is required unless --validate-only is used.");
  assert(targetRepository, "TARGET_REPOSITORY is required.");
  assert(pullRequestNumber && /^\d+$/.test(pullRequestNumber), "PULL_REQUEST_NUMBER must be a number.");

  const pullRequestIssue = await getPullRequestIssue(token, targetRepository, pullRequestNumber);
  const isTeamMember = createTeamMembershipChecker(token, properties.organization);
  const labels = await restoreStickyLabels({
    token,
    config,
    targetRepository,
    pullRequestNumber,
    pullRequestIssue,
    labels: Array.isArray(pullRequestIssue.labels) ? pullRequestIssue.labels : [],
    isTeamMember,
  });
  const reviews = await getPullRequestReviews(token, targetRepository, pullRequestNumber);
  const result = await evaluatePrLabelTest({
    config,
    targetRepository,
    pullRequestAuthor: pullRequestIssue?.user?.login,
    prLabels: labels,
    reviews,
    isTeamMember,
  });

  printEvaluation(result);

  if (!result.passed) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
