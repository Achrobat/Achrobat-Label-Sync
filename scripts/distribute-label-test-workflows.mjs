import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { assert, normalizeRepositoryRef, readJsonc } from "./lib/config-utils.mjs";
import {
  validateLabelTestWorkflowConfig,
  validateProperties,
} from "./lib/config-validation.mjs";
import {
  filterEligibleRepositories,
  formatRepositoryLink,
  formatSkippedRepository,
  isSourceRepository,
  parseTokenPermissions,
  repositoryAliases,
  repositoryMatchesEntries,
} from "./lib/repository-selection.mjs";

const workspaceRoot = process.cwd();
const propertiesPath = path.join(workspaceRoot, "config", "properties.jsonc");
const labelTestWorkflowConfigPath = path.join(workspaceRoot, "config", "label-test-workflow-config.jsonc");
const callerWorkflowPath = ".github/workflows/label-test.yml";
const updateBranchName = "label-sync/update-label-test-workflow";

const validateOnly = process.argv.includes("--validate-only");

function parseBoolean(value) {
  if (value === undefined || value === null || value === "") {
    return false;
  }

  return value.toLowerCase() === "true";
}

export function parseTargetRepositories(value) {
  if (!value || !value.trim()) {
    return null;
  }

  return new Set(
    value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => normalizeRepositoryRef(entry)),
  );
}

async function githubRequest(
  token,
  method,
  apiPath,
  body,
  { allowNotFound = false, allowConflict = false } = {},
) {
  const response = await fetch(`https://api.github.com${apiPath}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "label-sync-workflow-distributor",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (allowNotFound && response.status === 404) {
    return null;
  }

  if (allowConflict && response.status === 409) {
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

function encodeBase64(value) {
  return Buffer.from(value, "utf8").toString("base64");
}

function decodeBase64(value) {
  return Buffer.from(value, "base64").toString("utf8");
}

export function generateCallerWorkflow({ sourceRepository, sourceRef }) {
  return `name: 97 - Label Test

on:
  pull_request_target:
    types:
      - opened
      - synchronize
      - reopened
      - labeled
      - unlabeled
      - review_requested
      - ready_for_review
  pull_request_review:
    types:
      - submitted
      - edited
      - dismissed

permissions:
  contents: read
  issues: read
  pull-requests: read

jobs:
  label-test:
    uses: ${sourceRepository}/.github/workflows/97-label-test.yml@${sourceRef}
    with:
      label_sync_repository: ${sourceRepository}
      label_sync_ref: ${sourceRef}
      target_repository: \${{ github.repository }}
      pull_request_number: \${{ github.event.pull_request.number }}
    secrets: inherit
`;
}

export function normalizeDeliveryMode(value) {
  const normalized = String(value ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");

  if (normalized === "direct_commit") {
    return "direct_commit";
  }

  if (normalized === "pull_request" || normalized === "open_pr") {
    return "open_pr";
  }

  return normalized;
}

function displayBoolean(value) {
  return value ? "True" : "False";
}

function displayRepositorySelectionMode(value) {
  if (value === "custom") {
    return "Custom";
  }

  return value === "whitelist" ? "Whitelist" : "Blacklist";
}

function displayDeliveryMode(value) {
  return value === "open_pr" ? "Pull Request" : "Direct Commit";
}

function displayStatus(status) {
  const labels = {
    created: "Created",
    updated: "Updated",
    unchanged: "Unchanged",
    would_create: "Created",
    would_update: "Updated",
    failed: "Failed",
    not_processed: "Not Processed",
  };

  return labels[status] ?? status;
}

function countResultsByStatus(results) {
  return results.reduce((counts, result) => {
    const key = result.status === "would_create"
      ? "created"
      : result.status === "would_update"
        ? "updated"
        : result.status;
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
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

function formatDateOnly(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function escapeMarkdownTableCell(value) {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function formatPullRequest(result) {
  if (!result.pullRequest?.html_url) {
    return "";
  }

  return `[PR #${result.pullRequest.number}](${result.pullRequest.html_url})`;
}

export function renderDistributionSummaryMarkdown({
  generatedDate,
  actor,
  dryRun,
  repositorySelectionMode,
  deliveryMode,
  selectedRepositories,
  skippedRepositories,
  results,
}) {
  const counts = countResultsByStatus(results);
  const title = dryRun
    ? "Distribute Label Workflow Fake Changelog"
    : "Distribute Label Workflow Changelog";
  const summaryLines = [
    `Generated On: ${generatedDate}`,
    `Actor: ${actor || "Unavailable"}`,
    `Test Mode: ${displayBoolean(dryRun)}`,
    `Repository Selection Mode: ${displayRepositorySelectionMode(repositorySelectionMode)}`,
    `Delivery Mode: ${displayDeliveryMode(deliveryMode)}`,
    `Repositories Selected: ${selectedRepositories.length}`,
    `Repositories Skipped: ${skippedRepositories.length}`,
    `Created: ${counts.created ?? 0}`,
    `Updated: ${counts.updated ?? 0}`,
    `Unchanged: ${counts.unchanged ?? 0}`,
    `Failed: ${counts.failed ?? 0}`,
    `Not Processed: ${counts.not_processed ?? 0}`,
  ];
  const lines = [
    `# ${title}`,
    "",
    ...summaryLines.map(renderSummaryLine),
    "",
    "## Repository Results",
    "",
  ];

  if (results.length === 0) {
    lines.push("No repositories were processed.");
  } else {
    lines.push("| Repository | Result | Branch | Pull Request |");
    lines.push("| --- | --- | --- | --- |");

    for (const result of results) {
      let resultText = displayStatus(result.status);

      if (result.error) {
        resultText = result.status === "failed" && result.stage
          ? `${resultText} during ${result.stage}: ${result.error}`
          : `${resultText}: ${result.error}`;
      }
      lines.push(
        `| ${formatRepositoryLink(result.repository)} | ${escapeMarkdownTableCell(resultText)} | ${escapeMarkdownTableCell(result.branch)} | ${formatPullRequest(result)} |`,
      );
    }
  }

  if (skippedRepositories.length > 0) {
    lines.push("", "## Skipped Repositories", "");

    for (const skippedRepository of skippedRepositories) {
      lines.push(`- ${formatSkippedRepository(skippedRepository)}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

export function selectDistributionRepositories(
  repositories,
  {
    orgName,
    sourceRepository,
    mode,
    targetRepositories = null,
    workflowDistribution,
  },
) {
  assert(mode === "whitelist" || mode === "blacklist", 'Repository selection mode must be either "whitelist" or "blacklist".');

  if (targetRepositories) {
    const selected = repositories
      .filter((repository) => (
        !isSourceRepository(repository, sourceRepository, orgName)
        && repositoryMatchesEntries(repository, targetRepositories, orgName)
      ))
      .sort((left, right) => left.full_name.localeCompare(right.full_name));

    const available = new Set(
      repositories.flatMap((repository) => [...repositoryAliases(repository, orgName)]),
    );
    const missing = [...targetRepositories].filter((entry) => !available.has(entry));

    assert(
      missing.length === 0,
      `Requested repositories were not found in the discovered org repository set: ${missing.join(", ")}.`,
    );

    return selected;
  }

  return repositories
    .filter((repository) => {
      if (isSourceRepository(repository, sourceRepository, orgName)) {
        return false;
      }

      if (mode === "whitelist") {
        return repositoryMatchesEntries(repository, workflowDistribution.whitelist, orgName);
      }

      return !repositoryMatchesEntries(repository, workflowDistribution.blacklist, orgName);
    })
    .sort((left, right) => left.full_name.localeCompare(right.full_name));
}

async function getDefaultBranch(token, repositoryFullName) {
  const repository = await githubRequest(token, "GET", `/repos/${repositoryFullName}`);
  return repository.default_branch;
}

async function getFileContent(token, repositoryFullName, filePath, ref = null) {
  const query = ref ? `?ref=${encodeURIComponent(ref)}` : "";
  return githubRequest(
    token,
    "GET",
    `/repos/${repositoryFullName}/contents/${encodeURIComponent(filePath).replace(/%2F/g, "/")}${query}`,
    null,
    { allowNotFound: true },
  );
}

async function putFileContent(token, repositoryFullName, filePath, { branch, content, message, sha = null }) {
  const body = {
    branch,
    message,
    content: encodeBase64(content),
  };

  if (sha) {
    body.sha = sha;
  }

  return githubRequest(
    token,
    "PUT",
    `/repos/${repositoryFullName}/contents/${encodeURIComponent(filePath).replace(/%2F/g, "/")}`,
    body,
  );
}

async function getBranchRef(
  token,
  repositoryFullName,
  branchName,
  { allowEmptyRepository = false } = {},
) {
  return githubRequest(
    token,
    "GET",
    `/repos/${repositoryFullName}/git/ref/heads/${encodeURIComponent(branchName).replace(/%2F/g, "/")}`,
    null,
    { allowNotFound: true, allowConflict: allowEmptyRepository },
  );
}

async function createBranchRef(token, repositoryFullName, branchName, sha) {
  return githubRequest(
    token,
    "POST",
    `/repos/${repositoryFullName}/git/refs`,
    {
      ref: `refs/heads/${branchName}`,
      sha,
    },
  );
}

async function getOpenUpdatePullRequest(token, repositoryFullName, headOwner, branchName) {
  const pulls = await githubRequest(
    token,
    "GET",
    `/repos/${repositoryFullName}/pulls?state=open&head=${encodeURIComponent(`${headOwner}:${branchName}`)}&per_page=100`,
  );

  return pulls[0] ?? null;
}

async function createUpdatePullRequest(token, repositoryFullName, { branchName, baseBranch }) {
  return githubRequest(
    token,
    "POST",
    `/repos/${repositoryFullName}/pulls`,
    {
      title: "Update Label Test workflow",
      head: branchName,
      base: baseBranch,
      body: "Updates the generated caller workflow for the central Label Test workflow.",
    },
  );
}

const defaultDistributionApi = {
  getDefaultBranch,
  getFileContent,
  putFileContent,
  getBranchRef,
  createBranchRef,
  getOpenUpdatePullRequest,
  createUpdatePullRequest,
};

async function runDistributionStage(stage, operation) {
  try {
    return await operation();
  } catch (error) {
    const stagedError = error instanceof Error ? error : new Error(String(error));
    stagedError.stage ??= stage;
    throw stagedError;
  }
}

export async function writeCallerWorkflow(
  token,
  repository,
  {
    deliveryMode,
    content,
    dryRun,
    defaultBranch = null,
    defaultRef = null,
    api = defaultDistributionApi,
  },
) {
  const resolvedDefaultBranch = defaultBranch ?? await api.getDefaultBranch(token, repository.full_name);
  let targetBranch = resolvedDefaultBranch;
  let existing;

  if (deliveryMode === "open_pr") {
    const updateRef = await runDistributionStage(
      "branch",
      () => api.getBranchRef(token, repository.full_name, updateBranchName),
    );

    if (updateRef) {
      targetBranch = updateBranchName;
      existing = await runDistributionStage(
        "workflow_file",
        () => api.getFileContent(token, repository.full_name, callerWorkflowPath, targetBranch),
      );
    } else {
      const defaultFile = await runDistributionStage(
        "workflow_file",
        () => api.getFileContent(
          token,
          repository.full_name,
          callerWorkflowPath,
          resolvedDefaultBranch,
        ),
      );
      const defaultContent = defaultFile?.content
        ? decodeBase64(defaultFile.content.replace(/\s/g, ""))
        : null;

      if (defaultContent === content) {
        return {
          repository: repository.full_name,
          status: "unchanged",
          branch: resolvedDefaultBranch,
        };
      }

      targetBranch = updateBranchName;

      if (dryRun) {
        return {
          repository: repository.full_name,
          status: defaultFile ? "would_update" : "would_create",
          branch: targetBranch,
        };
      }

      const resolvedDefaultRef = defaultRef
        ?? await runDistributionStage(
          "branch",
          () => api.getBranchRef(token, repository.full_name, resolvedDefaultBranch),
        );
      assert(
        resolvedDefaultRef,
        `Default branch "${resolvedDefaultBranch}" was not found in ${repository.full_name}.`,
      );
      await runDistributionStage(
        "branch",
        () => api.createBranchRef(
          token,
          repository.full_name,
          updateBranchName,
          resolvedDefaultRef.object.sha,
        ),
      );
      existing = defaultFile;
    }
  } else {
    existing = await runDistributionStage(
      "workflow_file",
      () => api.getFileContent(token, repository.full_name, callerWorkflowPath, targetBranch),
    );
  }

  const existingContent = existing?.content ? decodeBase64(existing.content.replace(/\s/g, "")) : null;

  const contentChanged = existingContent !== content;

  if (dryRun && contentChanged) {
    return {
      repository: repository.full_name,
      status: existing ? "would_update" : "would_create",
      branch: targetBranch,
    };
  }

  if (contentChanged) {
    await runDistributionStage(
      "workflow_file",
      () => api.putFileContent(token, repository.full_name, callerWorkflowPath, {
        branch: targetBranch,
        content,
        message: "Update Label Test workflow",
        sha: existing?.sha ?? null,
      }),
    );
  }

  const result = {
    repository: repository.full_name,
    status: contentChanged ? (existing ? "updated" : "created") : "unchanged",
    branch: targetBranch,
  };

  if (deliveryMode === "open_pr" && !dryRun) {
    const existingPullRequest = await runDistributionStage(
      "pull_request",
      () => api.getOpenUpdatePullRequest(
        token,
        repository.full_name,
        repository.owner?.login ?? repository.full_name.split("/")[0],
        updateBranchName,
      ),
    );

    if (existingPullRequest) {
      result.pullRequest = existingPullRequest;
    } else {
      const defaultFile = await runDistributionStage(
        "workflow_file",
        () => api.getFileContent(
          token,
          repository.full_name,
          callerWorkflowPath,
          resolvedDefaultBranch,
        ),
      );
      const defaultContent = defaultFile?.content
        ? decodeBase64(defaultFile.content.replace(/\s/g, ""))
        : null;

      if (defaultContent !== content) {
        result.pullRequest = await runDistributionStage(
          "pull_request",
          () => api.createUpdatePullRequest(token, repository.full_name, {
            branchName: updateBranchName,
            baseBranch: resolvedDefaultBranch,
          }),
        );
      }
    }
  }

  return result;
}

export async function preflightDistributionRepository(
  token,
  repository,
  { api = defaultDistributionApi } = {},
) {
  const defaultBranch = await runDistributionStage(
    "preflight",
    () => api.getDefaultBranch(token, repository.full_name),
  );
  const defaultRef = await runDistributionStage(
    "preflight",
    () => api.getBranchRef(
      token,
      repository.full_name,
      defaultBranch,
      { allowEmptyRepository: true },
    ),
  );

  if (!defaultRef) {
    return { skipReason: "empty" };
  }

  return { defaultBranch, defaultRef };
}

export async function processDistributionRepositories(
  repositories,
  {
    token,
    deliveryMode,
    content,
    dryRun,
    api = defaultDistributionApi,
    preflight = preflightDistributionRepository,
    write = writeCallerWorkflow,
  },
) {
  const results = [];
  const skippedRepositories = [];
  let processingError = null;

  for (let index = 0; index < repositories.length; index += 1) {
    const repository = repositories[index];

    try {
      const repositoryState = await preflight(token, repository, { api });

      if (repositoryState.skipReason) {
        skippedRepositories.push({
          repository: repository.full_name,
          reason: repositoryState.skipReason,
        });
        continue;
      }

      results.push(await write(token, repository, {
        deliveryMode,
        content,
        dryRun,
        defaultBranch: repositoryState.defaultBranch,
        defaultRef: repositoryState.defaultRef,
        api,
      }));
    } catch (error) {
      processingError ??= error;
      results.push({
        repository: repository.full_name,
        status: "failed",
        stage: error.stage ?? "unknown",
        branch: deliveryMode === "open_pr" ? updateBranchName : "",
        error: error.message,
      });

      for (const remainingRepository of repositories.slice(index + 1)) {
        results.push({
          repository: remainingRepository.full_name,
          status: "not_processed",
          branch: deliveryMode === "open_pr" ? updateBranchName : "",
          error: `Stopped after failure in ${repository.full_name}.`,
        });
      }

      break;
    }
  }

  return { results, skippedRepositories, processingError };
}

function printSummary({ selectedRepositories, skippedRepositories, results, dryRun }) {
  console.log(`Dry run: ${dryRun ? "true" : "false"}`);
  console.log(`Repositories selected: ${selectedRepositories.length}`);
  console.log(`Repositories skipped: ${skippedRepositories.length}`);

  for (const skippedRepository of skippedRepositories) {
    console.log(`- skipped ${skippedRepository.repository}: ${skippedRepository.reason}`);
  }

  for (const result of results) {
    const pullRequestSuffix = result.pullRequest ? ` (${result.pullRequest.html_url})` : "";
    console.log(`- ${result.repository}: ${result.status} on ${result.branch}${pullRequestSuffix}`);
  }
}

async function writeRunSummary(markdown) {
  if (!process.env.GITHUB_STEP_SUMMARY) {
    return;
  }

  await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, markdown, "utf8");
  console.log("Wrote distribution summary to the GitHub Actions job summary.");
}

async function main() {
  const properties = validateProperties(await readJsonc(propertiesPath), {
    requireOrganization: true,
    requireLabelSyncTokenSecretName: true,
  });
  const config = validateLabelTestWorkflowConfig(await readJsonc(labelTestWorkflowConfigPath));

  if (validateOnly) {
    console.log("Label Test workflow configuration is valid.");
    return;
  }

  const token = process.env.LABEL_SYNC_TOKEN;
  assert(token, "LABEL_SYNC_TOKEN is required unless --validate-only is used.");

  const mode = process.env.REPOSITORY_SELECTION_MODE;
  const deliveryMode = normalizeDeliveryMode(process.env.DELIVERY_MODE);
  const dryRun = parseBoolean(process.env.DRY_RUN);
  const targetRepositories = parseTargetRepositories(process.env.TARGET_REPOSITORIES);
  assert(mode === "whitelist" || mode === "blacklist", 'REPOSITORY_SELECTION_MODE must be either "whitelist" or "blacklist".');
  assert(deliveryMode === "direct_commit" || deliveryMode === "open_pr", 'DELIVERY_MODE must be either "direct_commit" or "open_pr".');

  const orgName = process.env.ORG_NAME ?? process.env.GITHUB_REPOSITORY_OWNER ?? properties.organization;
  const sourceRepository = process.env.LABEL_TEST_SOURCE_REPOSITORY ?? process.env.GITHUB_REPOSITORY;
  const sourceRef = process.env.LABEL_TEST_SOURCE_REF ?? process.env.GITHUB_EVENT_REPOSITORY_DEFAULT_BRANCH ?? "main";
  assert(sourceRepository, "LABEL_TEST_SOURCE_REPOSITORY or GITHUB_REPOSITORY is required.");

  const discoveredRepositories = await getOrganizationRepositories(token, orgName);
  const selectedRepositories = selectDistributionRepositories(discoveredRepositories, {
    orgName,
    sourceRepository,
    mode,
    targetRepositories,
    workflowDistribution: config.workflowDistribution,
  });
  const tokenPermissions = parseTokenPermissions(process.env.LABEL_SYNC_TOKEN_PERMISSIONS);
  const requiredTokenPermissions = deliveryMode === "open_pr"
    ? ["contents", "workflows", "pull_requests"]
    : ["contents", "workflows"];
  const { repositories, skippedRepositories: eligibilitySkips } = filterEligibleRepositories(
    selectedRepositories,
    {
      orgName,
      requireWriteAccess: !dryRun,
      tokenPermissions,
      tokenWritePermission: requiredTokenPermissions,
    },
  );
  const content = generateCallerWorkflow({ sourceRepository, sourceRef });
  const {
    results,
    skippedRepositories: processingSkips,
    processingError,
  } = await processDistributionRepositories(repositories, {
    token,
    deliveryMode,
    content,
    dryRun,
  });
  const skippedRepositories = [...eligibilitySkips, ...processingSkips];

  printSummary({
    selectedRepositories,
    skippedRepositories,
    results,
    dryRun,
  });

  await writeRunSummary(renderDistributionSummaryMarkdown({
    generatedDate: formatDateOnly(),
    actor: process.env.GITHUB_ACTOR ?? "",
    dryRun,
    repositorySelectionMode: targetRepositories ? "custom" : mode,
    deliveryMode,
    selectedRepositories,
    skippedRepositories,
    results,
  }));

  if (processingError) {
    throw new Error("One or more repositories failed during Label Workflow distribution. See the workflow summary for details.");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
