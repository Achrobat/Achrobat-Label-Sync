import path from "node:path";
import { assert, normalizeName, readJsonc } from "./lib/config-utils.mjs";
import { validateProperties, validateRepositoryFilter } from "./lib/config-validation.mjs";
import { renderRemoveLabelsSection, writeChangelog } from "./lib/changelog-utils.mjs";
import {
  filterRepositories,
  isSourceRepository,
  repositoryAliases,
  repositoryMatchesEntries,
} from "./lib/repository-selection.mjs";

const workspaceRoot = process.cwd();
const propertiesPath = path.join(workspaceRoot, "config", "properties.jsonc");
const repositoryFilterPath = path.join(workspaceRoot, "config", "repository-filter.jsonc");

const validateOnly = process.argv.includes("--validate-only");
const dryRun = validateOnly || process.env.DRY_RUN === "true";
const runOnIssues = parseBoolean(process.env.RUN_ON_ISSUES);
const targetOnlyClosedIssues = parseBoolean(process.env.TARGET_ONLY_CLOSED_ISSUES) ?? false;
const runOnPullRequests = parseBoolean(process.env.RUN_ON_PULL_REQUESTS);
const targetOnlyClosedPullRequests = parseBoolean(process.env.TARGET_ONLY_CLOSED_PULL_REQUESTS) ?? false;
const labelName = (process.env.LABEL_NAME ?? "").trim();
const targetRepositoryFilter = parseRepositoryFilter(process.env.TARGET_REPOSITORIES);

function parseBoolean(value) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  return value.toLowerCase() === "true";
}

function parseRepositoryFilter(value) {
  if (!value) {
    return null;
  }

  return new Set(
    value
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
  );
}

function validateRunInputs() {
  assert(labelName, "LABEL_NAME is required.");
  assert(runOnIssues !== undefined, "RUN_ON_ISSUES must be provided.");
  assert(runOnPullRequests !== undefined, "RUN_ON_PULL_REQUESTS must be provided.");
  assert(
    runOnIssues || runOnPullRequests,
    'At least one of "Run on Issues" or "Run on Pull Requests" must be enabled.',
  );
}

function applyTargetRepositoryOverride(repositories, orgName, sourceRepository) {
  if (!targetRepositoryFilter) {
    return repositories;
  }

  const selected = repositories.filter((repository) => (
    !isSourceRepository(repository, sourceRepository, orgName)
    && repositoryMatchesEntries(repository, targetRepositoryFilter, orgName)
  ));

  const available = new Set(
    repositories.flatMap((repository) => [...repositoryAliases(repository, orgName)]),
  );
  const missing = [...targetRepositoryFilter].filter((entry) => !available.has(entry));

  assert(
    missing.length === 0,
    `Requested repositories were not found in the discovered org repository set: ${missing.join(", ")}.`,
  );

  return selected.sort((left, right) => left.full_name.localeCompare(right.full_name));
}

async function githubRequest(token, method, apiPath) {
  const response = await fetch(`https://api.github.com${apiPath}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "label-remove",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`${method} ${apiPath} failed with ${response.status}: ${message}`);
  }

  if (response.status === 204) {
    return null;
  }

  return response.json();
}

async function getOrganizationRepositories(token, orgName) {
  const repositories = [];
  let page = 1;

  while (true) {
    const batch = await githubRequest(
      token,
      "GET",
      `/orgs/${orgName}/repos?type=all&per_page=100&page=${page}`,
    );

    repositories.push(...batch);

    if (batch.length < 100) {
      return repositories;
    }

    page += 1;
  }
}

async function getLabelledIssues(token, repositoryFullName, state, requestedLabel) {
  const items = [];
  let page = 1;

  while (true) {
    const batch = await githubRequest(
      token,
      "GET",
      `/repos/${repositoryFullName}/issues?state=${state}&labels=${encodeURIComponent(requestedLabel)}&per_page=100&page=${page}`,
    );

    items.push(...batch);

    if (batch.length < 100) {
      return items;
    }

    page += 1;
  }
}

function findMatchingLabel(issueOrPullRequest, requestedLabel) {
  const labels = Array.isArray(issueOrPullRequest.labels) ? issueOrPullRequest.labels : [];
  const requestedKey = normalizeName(requestedLabel);
  return labels.find((label) => label && typeof label.name === "string" && normalizeName(label.name) === requestedKey) ?? null;
}

async function removeLabelFromIssue(token, repositoryFullName, number, actualLabelName) {
  await githubRequest(
    token,
    "DELETE",
    `/repos/${repositoryFullName}/issues/${number}/labels/${encodeURIComponent(actualLabelName)}`,
  );
}

async function processIssues(token, repository, requestedLabel) {
  const state = targetOnlyClosedIssues ? "closed" : "all";
  const candidates = await getLabelledIssues(token, repository.full_name, state, requestedLabel);
  const issues = candidates.filter((item) => !item.pull_request);
  const removed = [];

  for (const issue of issues) {
    const matchingLabel = findMatchingLabel(issue, requestedLabel);

    if (!matchingLabel) {
      continue;
    }

    if (!dryRun) {
      await removeLabelFromIssue(token, repository.full_name, issue.number, matchingLabel.name);
    }

    removed.push({
      number: issue.number,
      label: matchingLabel.name,
      url: issue.html_url,
    });
    console.log(`  ${dryRun ? "Would remove" : "Removed"} "${matchingLabel.name}" from issue #${issue.number}`);
  }

  return removed;
}

async function processPullRequests(token, repository, requestedLabel) {
  const state = targetOnlyClosedPullRequests ? "closed" : "all";
  const candidates = await getLabelledIssues(token, repository.full_name, state, requestedLabel);
  const pullRequests = candidates.filter((item) => item.pull_request);
  const removed = [];

  for (const pullRequest of pullRequests) {
    const matchingLabel = findMatchingLabel(pullRequest, requestedLabel);

    if (!matchingLabel) {
      continue;
    }

    if (!dryRun) {
      await removeLabelFromIssue(token, repository.full_name, pullRequest.number, matchingLabel.name);
    }

    removed.push({
      number: pullRequest.number,
      label: matchingLabel.name,
      url: pullRequest.html_url,
    });
    console.log(`  ${dryRun ? "Would remove" : "Removed"} "${matchingLabel.name}" from pull request #${pullRequest.number}`);
  }

  return removed;
}

async function processRepository(token, repository, requestedLabel) {
  console.log(`\nProcessing ${repository.full_name}`);

  const removedIssues = runOnIssues ? await processIssues(token, repository, requestedLabel) : [];
  const removedPullRequests = runOnPullRequests ? await processPullRequests(token, repository, requestedLabel) : [];

  console.log(
    `Summary for ${repository.full_name}: removedFromIssues=${removedIssues.length}, removedFromPullRequests=${removedPullRequests.length}`,
  );

  return {
    repository: repository.full_name,
    removedIssues,
    removedPullRequests,
  };
}

async function main() {
  const properties = validateProperties(await readJsonc(propertiesPath), {
    requireOrganization: true,
    requireLabelSyncTokenSecretName: true,
    includeSourceRepository: true,
    defaultSourceRepository: process.env.SOURCE_REPOSITORY ?? process.env.GITHUB_REPOSITORY ?? "",
  });
  const repositoryFilter = validateRepositoryFilter(await readJsonc(repositoryFilterPath));
  const activeFilterCount = repositoryFilter.useWhitelist ? repositoryFilter.whitelist.size : repositoryFilter.blacklist.size;
  const activeFilterMode = repositoryFilter.useWhitelist ? "whitelist" : "blacklist";

  console.log(
    `Loaded organization "${properties.organization}" and ${activeFilterCount} active repository filter entries from config/repository-filter.jsonc (mode=${activeFilterMode}).`,
  );

  if (validateOnly) {
    console.log("Configuration is valid.");
    return;
  }

  validateRunInputs();

  const token = process.env.LABEL_SYNC_TOKEN;
  assert(token, "LABEL_SYNC_TOKEN is required unless --validate-only is used.");

  const discoveredRepositories = await getOrganizationRepositories(token, properties.organization);
  const usingTargetRepositoryOverride = targetRepositoryFilter !== null;
  const repositories = usingTargetRepositoryOverride
    ? applyTargetRepositoryOverride(discoveredRepositories, properties.organization, properties.sourceRepository)
    : filterRepositories(
      discoveredRepositories,
      properties.organization,
      repositoryFilter,
      properties.sourceRepository,
    );

  if (usingTargetRepositoryOverride) {
    console.log(
      `Discovered ${discoveredRepositories.length} repositories in ${properties.organization}; ${repositories.length} selected by workflow repository override.`,
    );
  } else {
    console.log(
      `Discovered ${discoveredRepositories.length} repositories in ${properties.organization}; ${repositories.length} remain after repository-filter processing.`,
    );
  }

  if (repositories.length === 0) {
    console.log(
      usingTargetRepositoryOverride
        ? "No repositories were selected by the workflow repository override. Nothing to remove."
        : "No repositories remain after repository-filter processing. Nothing to remove.",
    );
    return;
  }

  console.log(dryRun ? "Running in dry-run mode." : "Applying changes.");
  console.log(
    `Removing exact label "${labelName}" from ${runOnIssues ? "issues" : ""}${runOnIssues && runOnPullRequests ? " and " : ""}${runOnPullRequests ? "pull requests" : ""}.`,
  );

  let totalRemovedIssues = 0;
  let totalRemovedPullRequests = 0;
  const results = [];

  for (const repository of repositories) {
    const result = await processRepository(token, repository, labelName);
    results.push(result);
    totalRemovedIssues += result.removedIssues.length;
    totalRemovedPullRequests += result.removedPullRequests.length;
  }

  console.log(
    `Completed label removal. Total removed from issues=${totalRemovedIssues}, total removed from pull requests=${totalRemovedPullRequests}.`,
  );

  await writeChangelog({
    workflowName: dryRun ? "Remove-Labels Fake" : "Remove-Labels",
    directoryName: dryRun ? "fake-changelogs" : "changelogs",
    introLines: [
      dryRun ? "Preview mode: true; no label removals were applied" : null,
      usingTargetRepositoryOverride
        ? "Repository selection: workflow dispatch config override"
        : `Repository filter mode: ${activeFilterMode}`,
      `Processed repositories: ${repositories.length}`,
      `Requested label: ${labelName}`,
      `Issue scope: ${runOnIssues ? (targetOnlyClosedIssues ? "closed issues only" : "all issues") : "disabled"}`,
      `Pull request scope: ${runOnPullRequests ? (targetOnlyClosedPullRequests ? "closed pull requests only" : "all pull requests") : "disabled"}`,
    ].filter((line) => line !== null),
    sections: results.map(renderRemoveLabelsSection),
  });
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
