import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assert,
  labelSpecKey,
  normalizeLabelSpec,
  normalizeRepositoryRef,
  readJsonc,
} from "./lib/config-utils.mjs";
import {
  validateLabels,
  validateProperties,
  validateRepositoryFilter,
} from "./lib/config-validation.mjs";
import {
  filterEligibleRepositories,
  filterRepositories,
  formatSkippedRepository,
  isSourceRepository,
  repositoryAliases,
  repositoryMatchesEntries,
} from "./lib/repository-selection.mjs";
import { getWorkflowMetadata } from "./lib/changelog-utils.mjs";

const workspaceRoot = process.cwd();
const propertiesPath = path.join(workspaceRoot, "config", "properties.jsonc");
const labelsPath = path.join(workspaceRoot, "config", "labels.jsonc");
const repositoryFilterPath = path.join(workspaceRoot, "config", "repository-filter.jsonc");

const validateOnly = process.argv.includes("--validate-only");
const excludeConfiguredLabels = parseBoolean(process.env.EXCLUDE_CONFIGURED_LABELS) ?? false;
const listSimilarities = parseBoolean(process.env.LIST_SIMILARITIES) ?? false;
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
      .map((entry) => normalizeRepositoryRef(entry))
      .filter(Boolean),
  );
}

function formatDisplayBoolean(value) {
  return value ? "True" : "False";
}

function formatRepositoryFilterMode(usingTargetRepositoryOverride, activeFilterMode) {
  if (usingTargetRepositoryOverride) {
    return "Custom";
  }

  return activeFilterMode === "whitelist" ? "Whitelist" : "Blacklist";
}

function renderSummaryLine(line) {
  const separatorIndex = line.indexOf(":");

  if (separatorIndex === -1) {
    return `- ${line}`;
  }

  const label = line.slice(0, separatorIndex + 1);
  const value = line.slice(separatorIndex + 1);
  return `- **${label}**${value}`;
}

function renderLabel(label) {
  const description = label.description ? `: ${label.description}` : "";
  return `\`${label.name}\` (${renderColor(label.color)})${description}`;
}

function renderColor(color) {
  return `\`#${color}\``;
}

function renderLabelDetails(label) {
  const lines = [
    `### \`${label.name}\``,
    "",
    `Color: ${renderColor(label.color)}`,
  ];

  if (label.description) {
    lines.push(`Description: ${label.description}`);
  }

  return lines;
}

export function filterConfiguredLabels(labels, configuredLabels) {
  const configuredKeys = new Set(configuredLabels.map((label) => labelSpecKey(label)));
  return labels
    .map((label) => normalizeLabelSpec(label))
    .filter((label) => !configuredKeys.has(labelSpecKey(label)));
}

export function buildSharedLabelGroups(results) {
  const groupsByKey = new Map();

  for (const result of results) {
    const seenInRepository = new Set();

    for (const label of result.labels) {
      const normalized = normalizeLabelSpec(label);
      const key = labelSpecKey(normalized);

      if (seenInRepository.has(key)) {
        continue;
      }

      seenInRepository.add(key);

      if (!groupsByKey.has(key)) {
        groupsByKey.set(key, {
          label: normalized,
          repositories: [],
        });
      }

      groupsByKey.get(key).repositories.push(result.repository);
    }
  }

  return [...groupsByKey.values()]
    .filter((group) => group.repositories.length >= 2)
    .sort((left, right) => (
      left.label.name.localeCompare(right.label.name)
      || left.label.color.localeCompare(right.label.color)
      || left.label.description.localeCompare(right.label.description)
    ));
}

export function renderInventorySummary({
  workflowName,
  generatedDate,
  actor,
  repoFilterMode,
  excludeConfiguredLabels: excludeConfigured,
  listSimilarities: includeSimilarities,
  results,
  sharedLabelGroups,
  skippedRepositories = [],
  failure = null,
}) {
  const labelsListed = results.reduce((count, result) => count + result.labels.length, 0);
  const summaryLines = [
    `Generated On: ${generatedDate}`,
    `Actor: ${actor || "Unavailable"}`,
    `Repo Filter Mode: ${repoFilterMode}`,
    `Exclude Configured Labels: ${formatDisplayBoolean(excludeConfigured)}`,
    `List Similarities: ${formatDisplayBoolean(includeSimilarities)}`,
    `Repositories Inventoried: ${results.length}`,
    `Repositories Skipped: ${skippedRepositories.length}`,
    `Labels Listed: ${labelsListed}`,
    includeSimilarities ? `Shared Label Count: ${sharedLabelGroups.length}` : null,
  ].filter((line) => line !== null);

  const lines = [
    `# ${workflowName}`,
    "",
    ...summaryLines.map(renderSummaryLine),
    "",
    "## Repository Label Inventory",
    "",
  ];

  for (const result of results) {
    if (result.labels.length === 0) {
      continue;
    }

    lines.push(`### ${result.repository}`);
    lines.push("");

    for (const label of result.labels) {
      lines.push(`- ${renderLabel(label)}`);
    }

    lines.push("");
  }

  if (includeSimilarities) {
    lines.push("## Shared Labels");
    lines.push("");

    if (sharedLabelGroups.length === 0) {
      lines.push("- No labels were shared by two or more selected repositories.");
      lines.push("");
    } else {
      for (const group of sharedLabelGroups) {
        lines.push(...renderLabelDetails(group.label));
        lines.push("");
        lines.push("Repositories:");

        for (const repository of group.repositories) {
          lines.push(`- ${repository}`);
        }

        lines.push("");
      }
    }
  }

  if (skippedRepositories.length > 0) {
    lines.push("## Skipped Repositories");
    lines.push("");
    lines.push(...skippedRepositories.map((skippedRepository) => `- ${formatSkippedRepository(skippedRepository)}`));
    lines.push("");
  }

  if (failure) {
    lines.push("## Workflow Failure");
    lines.push("");
    lines.push(`- ${failure.message ?? String(failure)}`);
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

function formatDatePath(date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    month: "2-digit",
    timeZone: process.env.CHANGELOG_TIME_ZONE || "America/New_York",
    year: "numeric",
  }).formatToParts(date);
  const partValues = Object.fromEntries(parts.map((part) => [part.type, part.value]));

  return `${partValues.year}-${partValues.month}-${partValues.day}`;
}

async function githubRequest(token, method, apiPath) {
  const response = await fetch(`https://api.github.com${apiPath}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "inventory-labels",
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

async function writeInventorySummary(markdown) {
  const stepSummaryPath = process.env.GITHUB_STEP_SUMMARY;

  if (!stepSummaryPath) {
    console.log("GITHUB_STEP_SUMMARY is not set; label inventory follows.");
    console.log(markdown);
    return null;
  }

  await fs.appendFile(stepSummaryPath, markdown, "utf8");
  console.log("Wrote label inventory to the GitHub Actions job summary.");
  return stepSummaryPath;
}

async function main() {
  const properties = validateProperties(await readJsonc(propertiesPath), {
    requireOrganization: true,
    requireLabelSyncTokenSecretName: true,
    includeSourceRepository: true,
    defaultSourceRepository: process.env.SOURCE_REPOSITORY ?? process.env.GITHUB_REPOSITORY ?? "",
  });
  const configuredLabels = validateLabels(await readJsonc(labelsPath));
  const repositoryFilter = validateRepositoryFilter(await readJsonc(repositoryFilterPath));
  const activeFilterCount = repositoryFilter.useWhitelist ? repositoryFilter.whitelist.size : repositoryFilter.blacklist.size;
  const activeFilterMode = repositoryFilter.useWhitelist ? "whitelist" : "blacklist";

  console.log(
    `Loaded ${configuredLabels.length} configured labels and ${activeFilterCount} active repository filter entries from config/repository-filter.jsonc (mode=${activeFilterMode}).`,
  );

  if (validateOnly) {
    console.log("Configuration is valid.");
    return;
  }

  const token = process.env.LABEL_SYNC_TOKEN;
  assert(token, "LABEL_SYNC_TOKEN is required unless --validate-only is used.");

  const discoveredRepositories = await getOrganizationRepositories(token, properties.organization);
  const usingTargetRepositoryOverride = targetRepositoryFilter !== null;
  const selectedRepositories = usingTargetRepositoryOverride
    ? applyTargetRepositoryOverride(discoveredRepositories, properties.organization, properties.sourceRepository)
    : filterRepositories(
      discoveredRepositories,
      properties.organization,
      repositoryFilter,
      properties.sourceRepository,
    );
  const { repositories, skippedRepositories } = filterEligibleRepositories(
    selectedRepositories,
    { orgName: properties.organization, requireWriteAccess: false },
  );

  if (usingTargetRepositoryOverride) {
    console.log(
      `Discovered ${discoveredRepositories.length} repositories in ${properties.organization}; ${selectedRepositories.length} selected by workflow repository override.`,
    );
  } else {
    console.log(
      `Discovered ${discoveredRepositories.length} repositories in ${properties.organization}; ${selectedRepositories.length} remain after repository-filter processing.`,
    );
  }

  if (skippedRepositories.length > 0) {
    console.log(`Skipping ${skippedRepositories.length} archived repositories.`);
  }

  const results = [];
  const writeRunSummary = async (failure = null) => {
    const metadata = getWorkflowMetadata("Inventory-Labels");
    const sharedLabelGroups = listSimilarities ? buildSharedLabelGroups(results) : [];
    const markdown = renderInventorySummary({
      workflowName: "Inventory-Labels",
      generatedDate: formatDatePath(new Date()),
      actor: metadata.actor,
      repoFilterMode: formatRepositoryFilterMode(usingTargetRepositoryOverride, activeFilterMode),
      excludeConfiguredLabels,
      listSimilarities,
      results,
      sharedLabelGroups,
      skippedRepositories,
      failure,
    });

    await writeInventorySummary(markdown);
  };

  if (repositories.length === 0) {
    console.log(
      usingTargetRepositoryOverride
        ? "No non-archived repositories were selected by the workflow repository override. Nothing to inventory."
        : "No non-archived repositories remain after repository-filter processing. Nothing to inventory.",
    );
    await writeRunSummary();
    return;
  }

  let processingError = null;

  try {
    for (const repository of repositories) {
      console.log(`\nInventorying ${repository.full_name}`);
      const labels = (await getAllLabels(token, repository.full_name))
        .map((label) => normalizeLabelSpec(label))
        .sort((left, right) => left.name.localeCompare(right.name));
      const inventoryLabels = excludeConfiguredLabels
        ? filterConfiguredLabels(labels, configuredLabels)
        : labels;

      console.log(`  Found ${labels.length} labels; listing ${inventoryLabels.length}.`);

      results.push({
        repository: repository.full_name,
        labels: inventoryLabels,
      });
    }
  } catch (error) {
    processingError = error;
  } finally {
    await writeRunSummary(processingError);
  }

  if (processingError) {
    throw processingError;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
