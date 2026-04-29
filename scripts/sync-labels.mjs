import path from "node:path";
import {
  assert,
  labelsExactlyMatch,
  normalizeColor,
  normalizeDescription,
  normalizeName,
  readJsonc,
} from "./lib/config-utils.mjs";
import {
  assertNoManagedDeletedLabelOverlap,
  validateDeletedLabels,
  validateGithubDefaultLabels,
  validateLabels,
  validateProperties,
  validateRepositoryFilter,
} from "./lib/config-validation.mjs";
import { renderLabelSyncSection, writeChangelog } from "./lib/changelog-utils.mjs";
import {
  filterRepositories,
  isSourceRepository,
  repositoryAliases,
  repositoryMatchesEntries,
} from "./lib/repository-selection.mjs";

const workspaceRoot = process.cwd();
const propertiesPath = path.join(workspaceRoot, "config", "properties.jsonc");
const labelsPath = path.join(workspaceRoot, "config", "labels.jsonc");
const deletedLabelsPath = path.join(workspaceRoot, "config", "deleted-labels.jsonc");
const githubDefaultLabelsPath = path.join(workspaceRoot, "config", "github-default-labels.jsonc");
const repositoryFilterPath = path.join(workspaceRoot, "config", "repository-filter.jsonc");

const validateOnly = process.argv.includes("--validate-only");
const dryRun = validateOnly || process.env.DRY_RUN === "true";
const deleteMissingOverride = parseBoolean(process.env.DELETE_MISSING);
const deleteGithubDefaultLabelsOverride = parseBoolean(process.env.DELETE_GITHUB_DEFAULT_LABELS);
const targetRepositoryFilter = parseRepositoryFilter(process.env.TARGET_REPOSITORIES);
const labelReplacements = parseLabelReplacements(process.env.LABEL_REPLACEMENTS);

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

function parseLabelReplacements(value) {
  if (!value || !value.trim()) {
    return [];
  }

  const seenOldNames = new Set();

  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const separatorIndex = entry.indexOf("=");
      assert(separatorIndex > 0 && separatorIndex < entry.length - 1, `Invalid label replacement "${entry}". Use old=new.`);
      assert(entry.indexOf("=", separatorIndex + 1) === -1, `Invalid label replacement "${entry}". Label replacement names cannot contain "=".`);

      const oldName = entry.slice(0, separatorIndex).trim();
      const newName = entry.slice(separatorIndex + 1).trim();
      assert(oldName, `Invalid label replacement "${entry}". Old label name is empty.`);
      assert(newName, `Invalid label replacement "${entry}". New label name is empty.`);

      const oldKey = normalizeName(oldName);
      const newKey = normalizeName(newName);
      assert(oldKey !== newKey, `Label replacement "${entry}" points to the same normalized label name.`);
      assert(!seenOldNames.has(oldKey), `Duplicate label replacement source detected: "${oldName}".`);
      seenOldNames.add(oldKey);

      return { oldName, newName, oldKey, newKey };
    });
}

async function githubRequest(token, method, apiPath, body) {
  const response = await fetch(`https://api.github.com${apiPath}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "label-sync",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: body ? JSON.stringify(body) : undefined,
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

async function getAllLabels(token, repo) {
  const labels = [];
  let page = 1;

  while (true) {
    const batch = await githubRequest(token, "GET", `/repos/${repo}/labels?per_page=100&page=${page}`);
    labels.push(...batch);

    if (batch.length < 100) {
      return labels;
    }

    page += 1;
  }
}

async function getIssuesAndPullRequestsWithLabel(token, repo, labelName) {
  const items = [];
  let page = 1;

  while (true) {
    const batch = await githubRequest(
      token,
      "GET",
      `/repos/${repo}/issues?state=all&labels=${encodeURIComponent(labelName)}&per_page=100&page=${page}`,
    );
    items.push(...batch);

    if (batch.length < 100) {
      return items;
    }

    page += 1;
  }
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

function summarizeLabelDiff(existing, desired) {
  if (!existing) {
    return "create";
  }

  const sameColor = normalizeColor(existing.color) === desired.color;
  const sameDescription = normalizeDescription(existing.description) === desired.description;
  const sameName = existing.name === desired.name;

  if (sameColor && sameDescription && sameName) {
    return "unchanged";
  }

  return "update";
}

function isExactGithubDefaultLabel(label, githubDefaultLabels) {
  return githubDefaultLabels.some((githubDefaultLabel) => labelsExactlyMatch(label, githubDefaultLabel));
}

function assertValidLabelReplacements(replacements, desiredLabels, deletedLabels) {
  const desiredKeys = new Set(desiredLabels.map((label) => normalizeName(label.name)));
  const deletedKeys = new Set(deletedLabels.map((label) => normalizeName(label.name)));

  for (const replacement of replacements) {
    assert(
      deletedKeys.has(replacement.oldKey),
      `Label replacement source "${replacement.oldName}" must exist in config/deleted-labels.jsonc.`,
    );
    assert(
      desiredKeys.has(replacement.newKey),
      `Label replacement target "${replacement.newName}" must exist in config/labels.jsonc.`,
    );
  }
}

function updateWorkingLabel(existingByName, workingLabels, key, nextLabel) {
  existingByName.set(key, nextLabel);
  const index = workingLabels.findIndex((label) => normalizeName(label.name) === key);

  if (index === -1) {
    workingLabels.push(nextLabel);
    return;
  }

  workingLabels[index] = nextLabel;
}

function removeWorkingLabel(existingByName, workingLabels, key) {
  existingByName.delete(key);
  const index = workingLabels.findIndex((label) => normalizeName(label.name) === key);

  if (index !== -1) {
    workingLabels.splice(index, 1);
  }
}

function countMigratedItems(items) {
  return items.reduce(
    (counts, item) => {
      if (item.pull_request) {
        counts.pullRequests += 1;
      } else {
        counts.issues += 1;
      }

      return counts;
    },
    { issues: 0, pullRequests: 0 },
  );
}

function hasLabel(item, labelName) {
  const requestedKey = normalizeName(labelName);
  const labels = Array.isArray(item.labels) ? item.labels : [];
  return labels.some((label) => label && typeof label.name === "string" && normalizeName(label.name) === requestedKey);
}

async function addLabelToIssueOrPullRequest(token, repositoryFullName, number, labelName) {
  return githubRequest(
    token,
    "POST",
    `/repos/${repositoryFullName}/issues/${number}/labels`,
    { labels: [labelName] },
  );
}

async function migrateLabelAssignments(token, repositoryFullName, oldLabelName, newLabelName) {
  const items = await getIssuesAndPullRequestsWithLabel(token, repositoryFullName, oldLabelName);
  const itemsNeedingNewLabel = items.filter((item) => !hasLabel(item, newLabelName));
  const matched = countMigratedItems(items);
  const added = countMigratedItems(itemsNeedingNewLabel);

  if (!dryRun) {
    for (const item of itemsNeedingNewLabel) {
      await addLabelToIssueOrPullRequest(token, repositoryFullName, item.number, newLabelName);
    }
  }

  return {
    matchedIssues: matched.issues,
    matchedPullRequests: matched.pullRequests,
    addedIssues: added.issues,
    addedPullRequests: added.pullRequests,
  };
}

async function applyLabelReplacements(token, repository, replacements, desiredByName, existingByName, workingLabels, result) {
  let replaced = 0;

  for (const replacement of replacements) {
    const existingOld = existingByName.get(replacement.oldKey);

    if (!existingOld) {
      continue;
    }

    const desiredNew = desiredByName.get(replacement.newKey);
    const existingNew = existingByName.get(replacement.newKey);

    if (!existingNew) {
      replaced += 1;
      result.labelReplacements.push({
        oldName: existingOld.name,
        newName: desiredNew.name,
        mode: "renamed",
        matchedIssues: null,
        matchedPullRequests: null,
        addedIssues: null,
        addedPullRequests: null,
      });
      result.hasChanges = true;
      console.log(`  ~ ${existingOld.name} -> ${desiredNew.name} (replacement rename)`);

      if (!dryRun) {
        await githubRequest(
          token,
          "PATCH",
          `/repos/${repository.full_name}/labels/${encodeURIComponent(existingOld.name)}`,
          desiredNew,
        );
      }

      removeWorkingLabel(existingByName, workingLabels, replacement.oldKey);
      updateWorkingLabel(existingByName, workingLabels, replacement.newKey, desiredNew);
      continue;
    }

    const migration = await migrateLabelAssignments(token, repository.full_name, existingOld.name, desiredNew.name);

    replaced += 1;
    result.labelReplacements.push({
      oldName: existingOld.name,
      newName: desiredNew.name,
      mode: "migrated",
      ...migration,
    });
    result.hasChanges = true;
    console.log(
      `  ~ ${existingOld.name} -> ${desiredNew.name} (replacement migration: issues=${migration.matchedIssues}, pullRequests=${migration.matchedPullRequests})`,
    );
    console.log(`  - ${existingOld.name} (replaced label config)`);

    if (!dryRun) {
      await githubRequest(
        token,
        "DELETE",
        `/repos/${repository.full_name}/labels/${encodeURIComponent(existingOld.name)}`,
      );
    }

    removeWorkingLabel(existingByName, workingLabels, replacement.oldKey);
  }

  return replaced;
}

async function syncRepository(
  token,
  repository,
  desiredLabels,
  deletedLabels,
  replacements,
  githubDefaultLabels,
  deleteMissing,
  deleteGithubDefaultLabels,
) {
  console.log(`\nSyncing ${repository.full_name}`);
  const workingLabels = await getAllLabels(token, repository.full_name);
  const existingByName = new Map(workingLabels.map((label) => [normalizeName(label.name), label]));
  const desiredByName = new Map(desiredLabels.map((label) => [normalizeName(label.name), label]));
  const desiredKeys = new Set(desiredLabels.map((label) => normalizeName(label.name)));
  const deletedKeys = new Set(deletedLabels.map((label) => normalizeName(label.name)));
  const result = {
    repository: repository.full_name,
    labelReplacements: [],
    createdLabels: [],
    updatedLabels: [],
    deletedConfiguredLabels: [],
    deletedGithubDefaultLabels: [],
    deletedMissingLabels: [],
    hasChanges: false,
  };

  let created = 0;
  let updated = 0;
  const replaced = await applyLabelReplacements(token, repository, replacements, desiredByName, existingByName, workingLabels, result);
  let deletedConfigured = 0;
  let deletedGithubDefaults = 0;
  let deletedMissing = 0;
  let unchanged = 0;

  for (const desired of desiredLabels) {
    const existing = existingByName.get(normalizeName(desired.name));
    const action = summarizeLabelDiff(existing, desired);

    if (action === "unchanged") {
      unchanged += 1;
      console.log(`  = ${desired.name}`);
      continue;
    }

    if (action === "create") {
      created += 1;
      result.createdLabels.push(desired);
      result.hasChanges = true;
      console.log(`  + ${desired.name}`);

      if (!dryRun) {
        await githubRequest(token, "POST", `/repos/${repository.full_name}/labels`, desired);
      }

      continue;
    }

    updated += 1;
    result.updatedLabels.push({
      before: {
        name: existing.name,
        color: normalizeColor(existing.color),
        description: normalizeDescription(existing.description),
      },
      after: desired,
    });
    result.hasChanges = true;
    console.log(`  ~ ${desired.name}`);

    if (!dryRun) {
      await githubRequest(
        token,
        "PATCH",
        `/repos/${repository.full_name}/labels/${encodeURIComponent(existing.name)}`,
        desired,
      );
    }
  }

  for (const existing of [...workingLabels]) {
    const existingKey = normalizeName(existing.name);

    if (!deletedKeys.has(existingKey)) {
      continue;
    }

    deletedConfigured += 1;
    result.deletedConfiguredLabels.push({
      name: existing.name,
      color: normalizeColor(existing.color),
      description: normalizeDescription(existing.description),
    });
    result.hasChanges = true;
    console.log(`  - ${existing.name} (deleted label config)`);

    if (!dryRun) {
      await githubRequest(
        token,
        "DELETE",
        `/repos/${repository.full_name}/labels/${encodeURIComponent(existing.name)}`,
      );
    }

    removeWorkingLabel(existingByName, workingLabels, existingKey);
  }

  if (deleteGithubDefaultLabels) {
    for (const existing of [...workingLabels]) {
      const existingKey = normalizeName(existing.name);

      if (desiredKeys.has(existingKey) || deletedKeys.has(existingKey) || !isExactGithubDefaultLabel(existing, githubDefaultLabels)) {
        continue;
      }

      deletedGithubDefaults += 1;
      result.deletedGithubDefaultLabels.push({
        name: existing.name,
        color: normalizeColor(existing.color),
        description: normalizeDescription(existing.description),
      });
      result.hasChanges = true;
      console.log(`  - ${existing.name} (GitHub default label)`);

      if (!dryRun) {
        await githubRequest(
          token,
          "DELETE",
          `/repos/${repository.full_name}/labels/${encodeURIComponent(existing.name)}`,
        );
      }

      removeWorkingLabel(existingByName, workingLabels, existingKey);
    }
  }

  if (deleteMissing) {
    for (const existing of [...workingLabels]) {
      const existingKey = normalizeName(existing.name);

      if (desiredKeys.has(existingKey) || deletedKeys.has(existingKey) || isExactGithubDefaultLabel(existing, githubDefaultLabels)) {
        continue;
      }

      deletedMissing += 1;
      result.deletedMissingLabels.push({
        name: existing.name,
        color: normalizeColor(existing.color),
        description: normalizeDescription(existing.description),
      });
      result.hasChanges = true;
      console.log(`  - ${existing.name} (delete missing)`);

      if (!dryRun) {
        await githubRequest(
          token,
          "DELETE",
          `/repos/${repository.full_name}/labels/${encodeURIComponent(existing.name)}`,
        );
      }

      removeWorkingLabel(existingByName, workingLabels, existingKey);
    }
  }

  console.log(
    `Summary for ${repository.full_name}: replaced=${replaced}, created=${created}, updated=${updated}, deletedConfigured=${deletedConfigured}, deletedGithubDefaults=${deletedGithubDefaults}, deletedMissing=${deletedMissing}, unchanged=${unchanged}`,
  );

  return result;
}

async function main() {
  const properties = validateProperties(await readJsonc(propertiesPath), {
    requireOrganization: true,
    requireLabelSyncTokenSecretName: true,
    includeSourceRepository: true,
    defaultSourceRepository: process.env.SOURCE_REPOSITORY ?? process.env.GITHUB_REPOSITORY ?? "",
  });
  const labels = validateLabels(await readJsonc(labelsPath));
  const deletedLabels = validateDeletedLabels(await readJsonc(deletedLabelsPath));
  assertNoManagedDeletedLabelOverlap(labels, deletedLabels);
  assertValidLabelReplacements(labelReplacements, labels, deletedLabels);
  const githubDefaultLabels = validateGithubDefaultLabels(await readJsonc(githubDefaultLabelsPath));
  const repositoryFilter = validateRepositoryFilter(await readJsonc(repositoryFilterPath));
  const activeFilterCount = repositoryFilter.useWhitelist ? repositoryFilter.whitelist.size : repositoryFilter.blacklist.size;
  const activeFilterMode = repositoryFilter.useWhitelist ? "whitelist" : "blacklist";

  console.log(
    `Loaded ${labels.length} managed labels, ${deletedLabels.length} deleted labels, ${labelReplacements.length} label replacements, ${githubDefaultLabels.length} GitHub default labels, and ${activeFilterCount} active repository filter entries from config/repository-filter.jsonc (mode=${activeFilterMode}).`,
  );

  if (validateOnly) {
    console.log("Configuration is valid.");
    return;
  }

  const token = process.env.LABEL_SYNC_TOKEN;
  assert(token, "LABEL_SYNC_TOKEN is required unless --validate-only is used.");
  const orgName = process.env.ORG_NAME ?? process.env.GITHUB_REPOSITORY_OWNER ?? properties.organization;
  assert(orgName, "ORG_NAME, GITHUB_REPOSITORY_OWNER, or properties.organization is required to discover organization repositories.");

  const discoveredRepositories = await getOrganizationRepositories(token, orgName);
  const usingTargetRepositoryOverride = targetRepositoryFilter !== null;
  const repositories = usingTargetRepositoryOverride
    ? applyTargetRepositoryOverride(discoveredRepositories, orgName, properties.sourceRepository)
    : filterRepositories(discoveredRepositories, orgName, repositoryFilter, properties.sourceRepository);

  if (usingTargetRepositoryOverride) {
    console.log(
      `Discovered ${discoveredRepositories.length} repositories in ${orgName}; ${repositories.length} selected by workflow repository override.`,
    );
  } else {
    console.log(
      `Discovered ${discoveredRepositories.length} repositories in ${orgName}; ${repositories.length} remain after repository-filter processing.`,
    );
  }

  if (repositories.length === 0) {
    console.log(
      usingTargetRepositoryOverride
        ? "No repositories were selected by the workflow repository override. Nothing to sync."
        : "No repositories remain after repository-filter processing. Nothing to sync.",
    );
    return;
  }

  console.log(dryRun ? "Running in dry-run mode." : "Applying changes.");
  const deleteMissing = deleteMissingOverride ?? false;
  const deleteGithubDefaultLabels = deleteGithubDefaultLabelsOverride ?? false;
  const results = [];

  for (const repository of repositories) {
    const result = await syncRepository(
      token,
      repository,
      labels,
      deletedLabels,
      labelReplacements,
      githubDefaultLabels,
      deleteMissing,
      deleteGithubDefaultLabels,
    );
    results.push(result);
  }

  await writeChangelog({
    workflowName: dryRun ? "Org-Label-Sync Fake" : "Org-Label-Sync",
    directoryName: dryRun ? "fake-changelogs" : "changelogs",
    introLines: [
      dryRun ? "Preview mode: true; no label changes were applied" : null,
      usingTargetRepositoryOverride
        ? "Repository selection: workflow dispatch config override"
        : `Repository filter mode: ${activeFilterMode}`,
      `Processed repositories: ${repositories.length}`,
      `Deleted-label config entries: ${deletedLabels.length}`,
      `Label replacements: ${labelReplacements.length}`,
      `Delete GitHub default labels: ${deleteGithubDefaultLabels}`,
      `Delete missing labels: ${deleteMissing}`,
    ].filter((line) => line !== null),
    sections: results.map(renderLabelSyncSection),
  });
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
