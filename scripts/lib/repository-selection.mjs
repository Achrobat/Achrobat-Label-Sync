import { normalizeName, normalizeRepositoryRef } from "./config-utils.mjs";

export function repositoryAliases(repository, orgName) {
  const aliases = new Set();

  if (repository.name) {
    aliases.add(normalizeRepositoryRef(repository.name));
  }

  if (repository.full_name) {
    aliases.add(normalizeRepositoryRef(repository.full_name));
  }

  const ownerName = repository.owner?.login ?? orgName;
  if (ownerName && repository.name) {
    aliases.add(normalizeRepositoryRef(`${ownerName}/${repository.name}`));
  }

  if (orgName && repository.name) {
    aliases.add(normalizeRepositoryRef(`${orgName}/${repository.name}`));
  }

  return aliases;
}

export function repositoryMatchesEntries(repository, entries, orgName) {
  const aliases = repositoryAliases(repository, orgName);
  return [...entries].some((entry) => aliases.has(entry));
}

export function repositoryDisplayName(repository, orgName) {
  if (repository.full_name) {
    return repository.full_name;
  }

  if (orgName && repository.name) {
    return `${orgName}/${repository.name}`;
  }

  return repository.name ?? "unknown";
}

export function parseTokenPermissions(value) {
  if (!value) {
    return null;
  }

  let parsed;

  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("LABEL_SYNC_TOKEN_PERMISSIONS must be a JSON object when provided.");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("LABEL_SYNC_TOKEN_PERMISSIONS must be a JSON object when provided.");
  }

  return parsed;
}

export function hasTokenWriteAccess(tokenPermissions, tokenWritePermission = "labels") {
  if (!tokenPermissions || typeof tokenPermissions !== "object") {
    return null;
  }

  if (Array.isArray(tokenWritePermission)) {
    return tokenWritePermission.every((permission) => (
      hasTokenWriteAccess(tokenPermissions, permission)
    ));
  }

  if (tokenWritePermission === "labels") {
    return tokenPermissions.issues === "write" || tokenPermissions.pull_requests === "write";
  }

  return tokenPermissions[tokenWritePermission] === "write";
}

export function hasTokenLabelWriteAccess(tokenPermissions) {
  return hasTokenWriteAccess(tokenPermissions, "labels");
}

export function hasRepositoryWriteAccess(repository, { tokenPermissions = null, tokenWritePermission = "labels" } = {}) {
  const hasTokenAccess = hasTokenWriteAccess(tokenPermissions, tokenWritePermission);

  if (hasTokenAccess !== null) {
    return hasTokenAccess;
  }

  const permissions = repository.permissions;

  if (!permissions || typeof permissions !== "object") {
    return true;
  }

  return Boolean(permissions.admin || permissions.maintain || permissions.push);
}

export function getRepositorySkipReason(
  repository,
  { requireWriteAccess = true, tokenPermissions = null, tokenWritePermission = "labels" } = {},
) {
  if (repository.archived) {
    return "archived";
  }

  if (requireWriteAccess && !hasRepositoryWriteAccess(repository, { tokenPermissions, tokenWritePermission })) {
    return "read-only";
  }

  return null;
}

export function filterEligibleRepositories(
  repositories,
  { orgName = "", requireWriteAccess = true, tokenPermissions = null, tokenWritePermission = "labels" } = {},
) {
  const eligibleRepositories = [];
  const skippedRepositories = [];

  for (const repository of repositories) {
    const reason = getRepositorySkipReason(repository, { requireWriteAccess, tokenPermissions, tokenWritePermission });

    if (reason) {
      skippedRepositories.push({
        repository: repositoryDisplayName(repository, orgName),
        reason,
      });
      continue;
    }

    eligibleRepositories.push(repository);
  }

  return {
    repositories: eligibleRepositories,
    skippedRepositories,
  };
}

export function filterRepositoriesForWriteMode(
  repositories,
  { orgName = "", dryRun = false, tokenPermissions = null } = {},
) {
  return filterEligibleRepositories(
    repositories,
    { orgName, requireWriteAccess: !dryRun, tokenPermissions },
  );
}

export function formatSkippedRepository(skippedRepository) {
  return `${formatRepositoryLink(skippedRepository.repository)} - ${skippedRepository.reason}`;
}

export function formatRepositoryLink(repositoryName, { serverUrl = process.env.GITHUB_SERVER_URL ?? "https://github.com" } = {}) {
  const baseUrl = (serverUrl || "https://github.com").replace(/\/+$/, "");
  return `[${repositoryName}](${baseUrl}/${repositoryName})`;
}

export function isSourceRepository(repository, sourceRepository, orgName) {
  if (!sourceRepository) {
    return false;
  }

  const sourceRef = normalizeRepositoryRef(sourceRepository);
  const separatorIndex = sourceRef.indexOf("/");

  if (separatorIndex === -1) {
    return false;
  }

  const sourceOwner = sourceRef.slice(0, separatorIndex);
  const sourceName = sourceRef.slice(separatorIndex + 1);
  const repositoryName = repository.name ? normalizeRepositoryRef(repository.name) : "";
  const repositoryFullName = repository.full_name ? normalizeRepositoryRef(repository.full_name) : "";

  if (repositoryFullName === sourceRef) {
    return true;
  }

  const ownerNames = new Set(
    [repository.owner?.login, orgName]
      .filter(Boolean)
      .map((ownerName) => normalizeRepositoryRef(ownerName)),
  );

  return repositoryName === sourceName && ownerNames.has(sourceOwner);
}

// Returns a repository's values for one custom property, normalized for comparison. Multi-select properties
// hold several values and unset properties hold none. Values come from repository.custom_properties, which
// loadRepositoryCustomProperties fills in from the organization's custom property values.
export function repositoryCustomPropertyValues(repository, propertyName) {
  const properties = repository.custom_properties;

  if (!properties || typeof properties !== "object") {
    return [];
  }

  const wantedName = normalizeName(propertyName);
  const actualName = Object.keys(properties).find((name) => normalizeName(name) === wantedName);

  if (actualName === undefined) {
    return [];
  }

  const value = properties[actualName];
  return (Array.isArray(value) ? value : [value])
    .filter((entry) => entry !== null && entry !== undefined && String(entry).trim() !== "")
    .map((entry) => normalizeName(String(entry)));
}

// A whitelist rule passes when the repository has one of the listed options. A blacklist rule passes when it
// has none of them, so repositories with no value for the property pass a blacklist rule.
export function repositoryPassesCustomPropertyRule(repository, rule) {
  const optionKeys = new Set(rule.options.map((option) => normalizeName(option)));
  const hasListedOption = repositoryCustomPropertyValues(repository, rule.property)
    .some((value) => optionKeys.has(value));

  return rule.mode === "whitelist" ? hasListedOption : !hasListedOption;
}

export function repositoryMatchesCustomProperties(repository, customProperties) {
  const { logic, rules } = customProperties;

  // Validation requires rules in customProperty mode; selecting nothing is the safe fallback.
  if (rules.length === 0) {
    return false;
  }

  return logic === "OR"
    ? rules.some((rule) => repositoryPassesCustomPropertyRule(repository, rule))
    : rules.every((rule) => repositoryPassesCustomPropertyRule(repository, rule));
}

// Applies a validated repository selection ({ filterMode, whitelist, blacklist, customProperties }).
export function repositoryPassesFilter(repository, orgName, repositoryFilter) {
  if (repositoryFilter.filterMode === "whitelist") {
    return repositoryMatchesEntries(repository, repositoryFilter.whitelist, orgName);
  }

  if (repositoryFilter.filterMode === "customProperty") {
    return repositoryMatchesCustomProperties(repository, repositoryFilter.customProperties);
  }

  return !repositoryMatchesEntries(repository, repositoryFilter.blacklist, orgName);
}

export function activeFilterEntryCount(repositoryFilter) {
  if (repositoryFilter.filterMode === "whitelist") {
    return repositoryFilter.whitelist.size;
  }

  if (repositoryFilter.filterMode === "customProperty") {
    return repositoryFilter.customProperties.rules.length;
  }

  return repositoryFilter.blacklist.size;
}

export function formatFilterMode(filterMode) {
  const names = {
    whitelist: "Whitelist",
    blacklist: "Blacklist",
    customProperty: "Custom Property",
    custom: "Custom",
  };

  return names[filterMode] ?? filterMode;
}

// For example: Team is Core or Addons AND Status is not Deprecated
export function describeCustomPropertyRules(customProperties) {
  return customProperties.rules
    .map((rule) => `${rule.property} ${rule.mode === "whitelist" ? "is" : "is not"} ${rule.options.join(" or ")}`)
    .join(` ${customProperties.logic} `);
}

export function filterRepositories(repositories, orgName, repositoryFilter, sourceRepository) {
  return repositories
    .filter((repository) => (
      !isSourceRepository(repository, sourceRepository, orgName)
      && repositoryPassesFilter(repository, orgName, repositoryFilter)
    ))
    .sort((left, right) => left.full_name.localeCompare(right.full_name));
}
