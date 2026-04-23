import path from "node:path";
import { assert, normalizeName, normalizeRepositoryRef, readJsonc } from "./lib/config-utils.mjs";

const workspaceRoot = process.cwd();
const propertiesPath = path.join(workspaceRoot, "config", "properties.jsonc");
const repositoryFilterPath = path.join(workspaceRoot, "config", "repository-filter.jsonc");

const validateOnly = process.argv.includes("--validate-only");
const runOnIssues = parseBoolean(process.env.RUN_ON_ISSUES);
const closedOnly = parseBoolean(process.env.CLOSED_ONLY) ?? false;
const runOnPullRequests = parseBoolean(process.env.RUN_ON_PULL_REQUESTS);
const mergedOnly = parseBoolean(process.env.MERGED_ONLY) ?? false;
const labelName = (process.env.LABEL_NAME ?? "").trim();

function parseBoolean(value) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  return value.toLowerCase() === "true";
}

function isFullRepositoryName(value) {
  return /^[^/\s]+\/[^/\s]+$/.test(value);
}

function isRepositoryName(value) {
  return /^[^/\s]+$/.test(value);
}

function validateProperties(properties) {
  assert(properties && typeof properties === "object" && !Array.isArray(properties), "config/properties.jsonc must contain an object.");
  assert(
    typeof properties.organization === "string" && properties.organization.trim(),
    "properties.organization must be a non-empty string.",
  );
  assert(
    typeof properties.labelSyncTokenSecretName === "string" && /^[A-Z_][A-Z0-9_]*$/.test(properties.labelSyncTokenSecretName),
    "properties.labelSyncTokenSecretName must look like a GitHub secret name.",
  );

  return {
    organization: properties.organization.trim(),
    labelSyncTokenSecretName: properties.labelSyncTokenSecretName.trim(),
  };
}

function validateRepositoryEntries(entries, configKey) {
  assert(Array.isArray(entries), `config/repository-filter.jsonc field "${configKey}" must contain an array.`);
  const seen = new Set();

  return new Set(entries.map((entry, index) => {
    assert(typeof entry === "string" && entry.trim(), `"${configKey}" entry at index ${index} must be a non-empty string.`);

    const name = entry.trim();
    assert(
      isRepositoryName(name) || isFullRepositoryName(name),
      `"${configKey}" entry "${name}" must be either "repo-name" or "owner/repo-name".`,
    );

    const key = normalizeRepositoryRef(name);
    assert(!seen.has(key), `Duplicate "${configKey}" entry detected: "${name}".`);
    seen.add(key);
    return key;
  }));
}

function validateRepositoryFilter(repositoryFilter) {
  assert(
    repositoryFilter && typeof repositoryFilter === "object" && !Array.isArray(repositoryFilter),
    "config/repository-filter.jsonc must contain an object.",
  );

  if (repositoryFilter.useWhitelist !== undefined) {
    assert(typeof repositoryFilter.useWhitelist === "boolean", 'config/repository-filter.jsonc field "useWhitelist" must be a boolean.');
  }

  return {
    useWhitelist: repositoryFilter.useWhitelist ?? false,
    whitelist: validateRepositoryEntries(repositoryFilter.whitelist ?? [], "whitelist"),
    blacklist: validateRepositoryEntries(repositoryFilter.blacklist ?? [], "blacklist"),
  };
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

function filterRepositories(repositories, orgName, repositoryFilter) {
  return repositories
    .filter((repository) => {
      const shortName = normalizeRepositoryRef(repository.name);
      const fullName = normalizeRepositoryRef(repository.full_name);
      const orgScopedName = normalizeRepositoryRef(`${orgName}/${repository.name}`);
      const matchesFilter = (entries) => (
        entries.has(shortName) || entries.has(fullName) || entries.has(orgScopedName)
      );

      if (repositoryFilter.useWhitelist) {
        return matchesFilter(repositoryFilter.whitelist);
      }

      return !matchesFilter(repositoryFilter.blacklist);
    })
    .sort((left, right) => left.full_name.localeCompare(right.full_name));
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

async function getPullRequestDetails(token, repositoryFullName, number) {
  return githubRequest(token, "GET", `/repos/${repositoryFullName}/pulls/${number}`);
}

async function removeLabelFromIssue(token, repositoryFullName, number, actualLabelName) {
  await githubRequest(
    token,
    "DELETE",
    `/repos/${repositoryFullName}/issues/${number}/labels/${encodeURIComponent(actualLabelName)}`,
  );
}

async function processIssues(token, repository, requestedLabel) {
  const state = closedOnly ? "closed" : "all";
  const candidates = await getLabelledIssues(token, repository.full_name, state, requestedLabel);
  const issues = candidates.filter((item) => !item.pull_request);
  let removed = 0;

  for (const issue of issues) {
    const matchingLabel = findMatchingLabel(issue, requestedLabel);

    if (!matchingLabel) {
      continue;
    }

    await removeLabelFromIssue(token, repository.full_name, issue.number, matchingLabel.name);
    removed += 1;
    console.log(`  Removed "${matchingLabel.name}" from issue #${issue.number}`);
  }

  return removed;
}

async function processPullRequests(token, repository, requestedLabel) {
  const state = mergedOnly ? "closed" : "all";
  const candidates = await getLabelledIssues(token, repository.full_name, state, requestedLabel);
  const pullRequests = candidates.filter((item) => item.pull_request);
  let removed = 0;

  for (const pullRequest of pullRequests) {
    const matchingLabel = findMatchingLabel(pullRequest, requestedLabel);

    if (!matchingLabel) {
      continue;
    }

    if (mergedOnly) {
      const details = await getPullRequestDetails(token, repository.full_name, pullRequest.number);

      if (!details.merged_at) {
        continue;
      }
    }

    await removeLabelFromIssue(token, repository.full_name, pullRequest.number, matchingLabel.name);
    removed += 1;
    console.log(`  Removed "${matchingLabel.name}" from pull request #${pullRequest.number}`);
  }

  return removed;
}

async function processRepository(token, repository, requestedLabel) {
  console.log(`\nProcessing ${repository.full_name}`);

  const removedIssues = runOnIssues ? await processIssues(token, repository, requestedLabel) : 0;
  const removedPullRequests = runOnPullRequests ? await processPullRequests(token, repository, requestedLabel) : 0;

  console.log(
    `Summary for ${repository.full_name}: removedFromIssues=${removedIssues}, removedFromPullRequests=${removedPullRequests}`,
  );

  return {
    removedIssues,
    removedPullRequests,
  };
}

async function main() {
  const properties = validateProperties(await readJsonc(propertiesPath));
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
  const repositories = filterRepositories(discoveredRepositories, properties.organization, repositoryFilter);

  console.log(
    `Discovered ${discoveredRepositories.length} repositories in ${properties.organization}; ${repositories.length} remain after repository-filter processing.`,
  );

  if (repositories.length === 0) {
    console.log("No repositories remain after repository-filter processing. Nothing to remove.");
    return;
  }

  console.log(
    `Removing exact label "${labelName}" from ${runOnIssues ? "issues" : ""}${runOnIssues && runOnPullRequests ? " and " : ""}${runOnPullRequests ? "pull requests" : ""}.`,
  );

  let totalRemovedIssues = 0;
  let totalRemovedPullRequests = 0;

  for (const repository of repositories) {
    const result = await processRepository(token, repository, labelName);
    totalRemovedIssues += result.removedIssues;
    totalRemovedPullRequests += result.removedPullRequests;
  }

  console.log(
    `Completed label removal. Total removed from issues=${totalRemovedIssues}, total removed from pull requests=${totalRemovedPullRequests}.`,
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
