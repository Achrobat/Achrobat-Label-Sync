import {
  assert,
  labelSpecKey,
  normalizeColor,
  normalizeLabelSpec,
  normalizeName,
  normalizeRepositoryRef,
} from "./config-utils.mjs";

function isFullRepositoryName(value) {
  return /^[^/\s]+\/[^/\s]+$/.test(value);
}

function isRepositoryName(value) {
  return /^[^/\s]+$/.test(value);
}

function isSecretName(value) {
  return typeof value === "string" && /^[A-Z_][A-Z0-9_]*$/.test(value.trim());
}

function validateSecretName(value, path) {
  assert(isSecretName(value), `${path} must look like a GitHub secret name.`);
  return value.trim();
}

function validateAuthentication(properties, { requireAuth, legacyTokenSecretRequired }) {
  const legacyPatSecretName = properties.labelSyncTokenSecretName;

  if (properties.authentication === undefined) {
    if (legacyTokenSecretRequired || legacyPatSecretName !== undefined) {
      return {
        mode: "pat",
        pat: {
          tokenSecretName: validateSecretName(legacyPatSecretName, "properties.labelSyncTokenSecretName"),
        },
        githubApp: {
          appIdSecretName: "",
          privateKeySecretName: "",
          installationIdSecretName: "",
        },
      };
    }

    assert(!requireAuth, "properties.authentication is required.");
    return undefined;
  }

  const { authentication } = properties;
  assert(
    authentication && typeof authentication === "object" && !Array.isArray(authentication),
    "properties.authentication must be an object.",
  );
  assert(
    authentication.mode === "pat" || authentication.mode === "githubApp",
    'properties.authentication.mode must be either "pat" or "githubApp".',
  );

  const pat = authentication.pat ?? {};
  assert(pat && typeof pat === "object" && !Array.isArray(pat), "properties.authentication.pat must be an object when provided.");

  const githubApp = authentication.githubApp ?? {};
  assert(
    githubApp && typeof githubApp === "object" && !Array.isArray(githubApp),
    "properties.authentication.githubApp must be an object when provided.",
  );

  const validated = {
    mode: authentication.mode,
    pat: {
      tokenSecretName: "",
    },
    githubApp: {
      appIdSecretName: "",
      privateKeySecretName: "",
      installationIdSecretName: "",
    },
  };

  if (authentication.mode === "pat") {
    validated.pat.tokenSecretName = validateSecretName(
      pat.tokenSecretName ?? legacyPatSecretName,
      "properties.authentication.pat.tokenSecretName",
    );
  } else if (pat.tokenSecretName !== undefined || legacyPatSecretName !== undefined) {
    validated.pat.tokenSecretName = validateSecretName(
      pat.tokenSecretName ?? legacyPatSecretName,
      "properties.authentication.pat.tokenSecretName",
    );
  }

  if (authentication.mode === "githubApp") {
    validated.githubApp.appIdSecretName = validateSecretName(
      githubApp.appIdSecretName,
      "properties.authentication.githubApp.appIdSecretName",
    );
    validated.githubApp.privateKeySecretName = validateSecretName(
      githubApp.privateKeySecretName,
      "properties.authentication.githubApp.privateKeySecretName",
    );
    validated.githubApp.installationIdSecretName = validateSecretName(
      githubApp.installationIdSecretName,
      "properties.authentication.githubApp.installationIdSecretName",
    );
  } else {
    if (githubApp.appIdSecretName !== undefined) {
      validated.githubApp.appIdSecretName = validateSecretName(
        githubApp.appIdSecretName,
        "properties.authentication.githubApp.appIdSecretName",
      );
    }
    if (githubApp.privateKeySecretName !== undefined) {
      validated.githubApp.privateKeySecretName = validateSecretName(
        githubApp.privateKeySecretName,
        "properties.authentication.githubApp.privateKeySecretName",
      );
    }
    if (githubApp.installationIdSecretName !== undefined) {
      validated.githubApp.installationIdSecretName = validateSecretName(
        githubApp.installationIdSecretName,
        "properties.authentication.githubApp.installationIdSecretName",
      );
    }
  }

  return validated;
}

export function validateProperties(properties, options = {}) {
  const {
    requireOrganization = false,
    requireLabelSyncTokenSecretName = false,
    requireAuthentication = requireLabelSyncTokenSecretName,
    includeSourceRepository = false,
    defaultSourceRepository = "",
    includeDeleteMissingByDefault = false,
  } = options;

  assert(properties && typeof properties === "object" && !Array.isArray(properties), "config/properties.jsonc must contain an object.");

  const validated = {};

  if (requireOrganization) {
    assert(
      typeof properties.organization === "string" && properties.organization.trim(),
      "properties.organization must be a non-empty string.",
    );
    validated.organization = properties.organization.trim();
  }

  const authentication = validateAuthentication(properties, {
    requireAuth: requireAuthentication,
    legacyTokenSecretRequired: requireLabelSyncTokenSecretName && properties.authentication === undefined,
  });

  if (authentication) {
    validated.authentication = authentication;
    validated.authMode = authentication.mode;
    validated.labelSyncTokenSecretName = authentication.pat.tokenSecretName;
    validated.githubAppIdSecretName = authentication.githubApp.appIdSecretName;
    validated.githubAppPrivateKeySecretName = authentication.githubApp.privateKeySecretName;
    validated.githubAppInstallationIdSecretName = authentication.githubApp.installationIdSecretName;
  }

  if (properties.sourceRepository !== undefined) {
    assert(
      typeof properties.sourceRepository === "string" && /^[^/\s]+\/[^/\s]+$/.test(properties.sourceRepository.trim()),
      "properties.sourceRepository must match owner/repo when provided.",
    );
  }

  if (includeSourceRepository) {
    validated.sourceRepository = (properties.sourceRepository ?? defaultSourceRepository).trim();
  }

  if (properties.deleteMissingByDefault !== undefined) {
    assert(typeof properties.deleteMissingByDefault === "boolean", "properties.deleteMissingByDefault must be a boolean.");
  }

  if (includeDeleteMissingByDefault) {
    validated.deleteMissingByDefault = properties.deleteMissingByDefault ?? false;
  }

  return validated;
}

export function validateLabels(labels) {
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

    return normalizeLabelSpec(label);
  });
}

export function validateDeleteLabels(deleteLabels) {
  assert(Array.isArray(deleteLabels), "config/auto-pruned-labels.jsonc must contain an array.");

  const seen = new Set();

  return deleteLabels.map((entry, index) => {
    assert(entry && typeof entry === "object" && !Array.isArray(entry), `Delete label at index ${index} must be an object.`);
    assert(typeof entry.name === "string" && entry.name.trim(), `Delete label at index ${index} is missing a valid name.`);
    assert(typeof entry.color === "string" && /^[0-9a-fA-F]{6}$/.test(normalizeColor(entry.color)), `Delete label "${entry.name}" must have a 6-character hex color.`);
    assert(typeof entry.description === "string", `Delete label "${entry.name}" must include a string description.`);

    const normalized = normalizeLabelSpec(entry);
    const key = labelSpecKey(normalized);
    assert(!seen.has(key), `Duplicate exact delete label detected: "${normalized.name}".`);
    seen.add(key);
    return normalized;
  });
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

export function validateRepositoryFilter(repositoryFilter) {
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
