import { normalizeRepositoryRef } from "./config-utils.mjs";

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

  if (tokenWritePermission === "contents") {
    return tokenPermissions.contents === "write";
  }

  return tokenPermissions.issues === "write" || tokenPermissions.pull_requests === "write";
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

export function filterRepositories(repositories, orgName, repositoryFilter, sourceRepository) {
  return repositories
    .filter((repository) => {
      if (isSourceRepository(repository, sourceRepository, orgName)) {
        return false;
      }

      if (repositoryFilter.useWhitelist) {
        return repositoryMatchesEntries(repository, repositoryFilter.whitelist, orgName);
      }

      return !repositoryMatchesEntries(repository, repositoryFilter.blacklist, orgName);
    })
    .sort((left, right) => left.full_name.localeCompare(right.full_name));
}
