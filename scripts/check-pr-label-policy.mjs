import path from "node:path";
import { pathToFileURL } from "node:url";
import { assert, readJsonc } from "./lib/config-utils.mjs";
import {
  validateLabelTestWorkflowConfig,
  validateProperties,
} from "./lib/config-validation.mjs";
import { evaluatePrLabelTest } from "./lib/label-test-workflow.mjs";

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

async function getPullRequestLabels(token, repository, pullRequestNumber) {
  const issue = await githubRequest(token, "GET", `/repos/${repository}/issues/${pullRequestNumber}`);
  return Array.isArray(issue.labels) ? issue.labels : [];
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

  const labels = await getPullRequestLabels(token, targetRepository, pullRequestNumber);
  const reviews = await getPullRequestReviews(token, targetRepository, pullRequestNumber);
  const result = await evaluatePrLabelTest({
    config,
    prLabels: labels,
    reviews,
    isTeamMember: createTeamMembershipChecker(token, properties.organization),
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
