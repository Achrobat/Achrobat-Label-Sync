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
