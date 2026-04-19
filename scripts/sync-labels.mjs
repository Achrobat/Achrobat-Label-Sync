import path from "node:path";
import {
  assert,
  normalizeColor,
  normalizeDescription,
  normalizeName,
  normalizeRepositoryRef,
  readJsonc,
} from "./lib/config-utils.mjs";

const workspaceRoot = process.cwd();
const propertiesPath = path.join(workspaceRoot, "config", "properties.jsonc");
const labelsPath = path.join(workspaceRoot, "config", "labels.jsonc");
const autoPrunedLabelsPath = path.join(workspaceRoot, "config", "auto-pruned-labels.jsonc");
const repositoryFilterPath = path.join(workspaceRoot, "config", "repository-filter.jsonc");

const validateOnly = process.argv.includes("--validate-only");
const dryRun = validateOnly || process.env.DRY_RUN === "true";
const deleteMissingOverride = parseBoolean(process.env.DELETE_MISSING);
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

  if (properties.sourceRepository !== undefined) {
    assert(
      typeof properties.sourceRepository === "string" && /^[^/\s]+\/[^/\s]+$/.test(properties.sourceRepository.trim()),
      "properties.sourceRepository must match owner/repo when provided.",
    );
  }

  if (properties.deleteMissingByDefault !== undefined) {
    assert(typeof properties.deleteMissingByDefault === "boolean", "properties.deleteMissingByDefault must be a boolean.");
  }

  return {
    organization: properties.organization.trim(),
    labelSyncTokenSecretName: properties.labelSyncTokenSecretName.trim(),
    sourceRepository: (properties.sourceRepository ?? "").trim(),
    deleteMissingByDefault: properties.deleteMissingByDefault ?? false,
  };
}

function validateLabels(labels) {
  assert(Array.isArray(labels), "config/labels.jsonc must contain an array.");

  const seen = new Set();

  return labels.map((label, index) => {
    assert(label && typeof label === "object" && !Array.isArray(label), `Label at index ${index} must be an object.`);
    assert(typeof label.name === "string" && label.name.trim(), `Label at index ${index} is missing a valid name.`);
    assert(typeof label.color === "string" && /^[0-9a-fA-F]{6}$/.test(normalizeColor(label.color)), `Label "${label.name}" must have a 6-character hex color.`);

    const key = normalizeName(label.name);
    assert(!seen.has(key), `Duplicate label name detected: "${label.name}".`);
    seen.add(key);

    if (label.description !== undefined) {
      assert(typeof label.description === "string", `Label "${label.name}" has a non-string description.`);
    }

    return {
      name: label.name.trim(),
      color: normalizeColor(label.color),
      description: normalizeDescription(label.description),
    };
  });
}

function validateDeleteLabels(deleteLabels) {
  assert(Array.isArray(deleteLabels), "config/auto-pruned-labels.jsonc must contain an array.");

  const seen = new Set();

  return deleteLabels.map((entry, index) => {
    assert(typeof entry === "string" && entry.trim(), `Delete label at index ${index} must be a non-empty string.`);

    const name = entry.trim();
    const key = normalizeName(name);
    assert(!seen.has(key), `Duplicate delete label detected: "${name}".`);
    seen.add(key);
    return name;
  });
}

function assertNoLabelOverlap(desiredLabels, deleteLabels) {
  const desiredKeys = new Set(desiredLabels.map((label) => normalizeName(label.name)));
  const overlaps = deleteLabels.filter((label) => desiredKeys.has(normalizeName(label)));

  assert(
    overlaps.length === 0,
    `Labels cannot exist in both config/labels.jsonc and config/auto-pruned-labels.jsonc: ${overlaps.join(", ")}.`,
  );
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

function applyTargetRepositoryFilter(repositories) {
  if (!targetRepositoryFilter) {
    return repositories;
  }

  const selected = repositories.filter((repository) => {
    const shortName = normalizeRepositoryRef(repository.name);
    const fullName = normalizeRepositoryRef(repository.full_name);
    return targetRepositoryFilter.has(shortName) || targetRepositoryFilter.has(fullName);
  });

  const available = new Set(
    repositories.flatMap((repository) => [
      normalizeRepositoryRef(repository.name),
      normalizeRepositoryRef(repository.full_name),
    ]),
  );
  const missing = [...targetRepositoryFilter].filter((entry) => !available.has(entry));

  assert(
    missing.length === 0,
    `Requested repositories were not found in the discovered org repository set after repository-filter processing: ${missing.join(", ")}.`,
  );

  return selected;
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

async function syncRepository(token, repository, desiredLabels, deleteLabels, deleteMissing) {
  console.log(`\nSyncing ${repository.full_name}`);
  const existingLabels = await getAllLabels(token, repository.full_name);
  const existingByName = new Map(existingLabels.map((label) => [normalizeName(label.name), label]));
  const desiredKeys = new Set(desiredLabels.map((label) => normalizeName(label.name)));
  const deleteKeys = new Set(deleteLabels.map((label) => normalizeName(label)));

  let created = 0;
  let updated = 0;
  let deletedConfigured = 0;
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
      console.log(`  + ${desired.name}`);

      if (!dryRun) {
        await githubRequest(token, "POST", `/repos/${repository.full_name}/labels`, desired);
      }

      continue;
    }

    updated += 1;
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

  for (const existing of existingLabels) {
    if (!deleteKeys.has(normalizeName(existing.name))) {
      continue;
    }

    deletedConfigured += 1;
    console.log(`  - ${existing.name} (configured delete)`);

    if (!dryRun) {
      await githubRequest(
        token,
        "DELETE",
        `/repos/${repository.full_name}/labels/${encodeURIComponent(existing.name)}`,
      );
    }
  }

  if (deleteMissing) {
    for (const existing of existingLabels) {
      const existingKey = normalizeName(existing.name);

      if (desiredKeys.has(existingKey) || deleteKeys.has(existingKey)) {
        continue;
      }

      deletedMissing += 1;
      console.log(`  - ${existing.name} (delete missing)`);

      if (!dryRun) {
        await githubRequest(
          token,
          "DELETE",
          `/repos/${repository.full_name}/labels/${encodeURIComponent(existing.name)}`,
        );
      }
    }
  }

  console.log(
    `Summary for ${repository.full_name}: created=${created}, updated=${updated}, deletedConfigured=${deletedConfigured}, deletedMissing=${deletedMissing}, unchanged=${unchanged}`,
  );
}

async function main() {
  const properties = validateProperties(await readJsonc(propertiesPath));
  const labels = validateLabels(await readJsonc(labelsPath));
  const deleteLabels = validateDeleteLabels(await readJsonc(autoPrunedLabelsPath));
  assertNoLabelOverlap(labels, deleteLabels);
  const repositoryFilter = validateRepositoryFilter(await readJsonc(repositoryFilterPath));
  const activeFilterCount = repositoryFilter.useWhitelist ? repositoryFilter.whitelist.size : repositoryFilter.blacklist.size;
  const activeFilterMode = repositoryFilter.useWhitelist ? "whitelist" : "blacklist";

  console.log(
    `Loaded ${labels.length} managed labels, ${deleteLabels.length} auto-pruned labels, and ${activeFilterCount} active repository filter entries from config/repository-filter.jsonc (mode=${activeFilterMode}).`,
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
  const repositories = applyTargetRepositoryFilter(
    filterRepositories(discoveredRepositories, orgName, repositoryFilter),
  );

  console.log(
    `Discovered ${discoveredRepositories.length} repositories in ${orgName}; ${repositories.length} remain after repository-filter processing.`,
  );

  if (repositories.length === 0) {
    console.log("No repositories remain after repository-filter processing and optional subset filtering. Nothing to sync.");
    return;
  }

  console.log(dryRun ? "Running in dry-run mode." : "Applying changes.");
  const deleteMissing = deleteMissingOverride ?? properties.deleteMissingByDefault;

  for (const repository of repositories) {
    await syncRepository(token, repository, labels, deleteLabels, deleteMissing);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
