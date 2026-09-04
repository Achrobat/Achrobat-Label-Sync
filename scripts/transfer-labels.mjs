import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { assert, labelsExactlyMatch, normalizeDescription, normalizeName } from "./lib/config-utils.mjs";
import { validateLabels } from "./lib/config-validation.mjs";
import { renderLabelSyncSection, writeChangelog } from "./lib/changelog-utils.mjs";
import { formatRepositoryLink, getRepositorySkipReason, parseTokenPermissions } from "./lib/repository-selection.mjs";

function resolveRepository(value, organization, inputName) {
  const name = typeof value === "string" ? value.trim() : "";
  assert(name, `${inputName} is required.`);
  const fullName = name.includes("/") ? name : `${organization ?? ""}/${name}`;
  const parts = fullName.split("/");
  assert(
    parts.length === 2
      && /^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(parts[0])
      && /^[a-zA-Z0-9_.-]+$/.test(parts[1])
      && parts[1] !== "." && parts[1] !== "..",
    `${inputName} must be a repository name in the configured organization or owner/repo.`,
  );
  return fullName;
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
    throw new Error(`${method} ${apiPath} failed with ${response.status}: ${await response.text()}`);
  }
  return response.status === 204 ? null : response.json();
}

async function getAllLabels(token, repository) {
  const labels = [];
  for (let page = 1; ; page += 1) {
    const batch = await githubRequest(token, "GET", `/repos/${repository}/labels?per_page=100&page=${page}`);
    assert(Array.isArray(batch), `Invalid label response for ${repository}.`);
    labels.push(...batch);
    if (batch.length < 100) {
      return validateLabels(labels.map((label) => ({
        ...label,
        description: normalizeDescription(label.description),
      })));
    }
  }
}

export async function transferLabels({
  token,
  organization,
  sourceRepository,
  targetRepository,
  dryRun = false,
  overrideExisting = false,
  tokenPermissions = null,
}) {
  const result = {
    repository: "",
    hasChanges: false,
    createdLabels: [],
    updatedLabels: [],
    deletedConfiguredLabels: [],
    deletedGithubDefaultLabels: [],
    deletedMissingLabels: [],
    labelReplacements: [],
  };
  const skippedRepositories = [];
  let sourceName;
  let targetName;
  let sourceCount = null;
  let initialTargetCount = null;
  let retainedCount = 0;
  let failure = null;

  try {
    sourceName = resolveRepository(sourceRepository, organization, "Source repository");
    targetName = resolveRepository(targetRepository, organization, "Receiving repository");
    assert(sourceName.toLowerCase() !== targetName.toLowerCase(), "Source and receiving repositories must be different repositories.");
    assert(token, "LABEL_SYNC_TOKEN is required.");
    const source = await githubRequest(token, "GET", `/repos/${sourceName}`);
    const target = await githubRequest(token, "GET", `/repos/${targetName}`);
    assert(source.id && target.id, "GitHub did not return valid repository IDs.");
    assert(source.id !== target.id, "Source and receiving repositories must be different repositories.");
    // Use canonical names after resolving renamed/transferred repository aliases.
    sourceName = resolveRepository(source.full_name, organization, "Source repository");
    targetName = resolveRepository(target.full_name, organization, "Receiving repository");
    result.repository = targetName;

    const skipReason = getRepositorySkipReason(target, { requireWriteAccess: !dryRun, tokenPermissions });
    if (skipReason) {
      skippedRepositories.push({ repository: targetName, reason: skipReason });
      return result;
    }

    // Read and validate both complete label sets before making any changes.
    const sourceLabels = await getAllLabels(token, sourceName);
    sourceCount = sourceLabels.length;
    const targetLabels = await getAllLabels(token, targetName);
    initialTargetCount = targetLabels.length;
    if (overrideExisting) {
      for (const label of targetLabels) {
        assert(
          label.name !== "." && label.name !== "..",
          `Receiving repository label "${label.name}" cannot be safely addressed by the GitHub API.`,
        );
      }
    }
    const targetByName = new Map(targetLabels.map((label) => [normalizeName(label.name), label]));
    const sourceNames = new Set(sourceLabels.map((label) => normalizeName(label.name)));
    retainedCount = overrideExisting
      ? sourceLabels.filter((label) => {
        const existing = targetByName.get(normalizeName(label.name));
        return existing && labelsExactlyMatch(existing, label);
      }).length
      : targetLabels.length;

    console.log(`${dryRun ? "Previewing" : "Applying"} ${overrideExisting ? "override" : "additive"} label transfer: ${sourceName} -> ${targetName}.`);
    for (const desired of sourceLabels) {
      const existing = targetByName.get(normalizeName(desired.name));
      if (!existing) {
        if (!dryRun) {
          await githubRequest(token, "POST", `/repos/${targetName}/labels`, desired);
        }
        result.createdLabels.push(desired);
        result.hasChanges = true;
        console.log(`  + ${desired.name}`);
      } else if (overrideExisting && !labelsExactlyMatch(existing, desired)) {
        if (!dryRun) {
          await githubRequest(token, "PATCH", `/repos/${targetName}/labels/${encodeURIComponent(existing.name)}`, {
            new_name: desired.name,
            color: desired.color,
            description: desired.description,
          });
        }
        result.updatedLabels.push({ before: existing, after: desired });
        result.hasChanges = true;
        console.log(`  ~ ${desired.name}`);
      }
    }

    // Delete extras only after every create/update has succeeded. Updating shared
    // labels in place preserves their existing issue and pull request assignments.
    if (overrideExisting) {
      for (const existing of targetLabels) {
        if (sourceNames.has(normalizeName(existing.name))) continue;
        if (!dryRun) {
          await githubRequest(token, "DELETE", `/repos/${targetName}/labels/${encodeURIComponent(existing.name)}`);
        }
        result.deletedConfiguredLabels.push(existing);
        result.hasChanges = true;
        console.log(`  - ${existing.name}`);
      }
    }
    return result;
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    await writeChangelog({
      workflowName: dryRun ? "Transfer-Labels Fake" : "Transfer-Labels",
      summaryLines: ({ generatedDate, metadata }) => [
        `Generated On: ${generatedDate}`,
        `Actor: ${metadata.actor || "Unavailable"}`,
        `Test Mode: ${dryRun ? "True" : "False"}`,
        `Source Repository: ${sourceName ? formatRepositoryLink(sourceName) : "Unavailable"}`,
        `Receiving Repository: ${targetName ? formatRepositoryLink(targetName) : "Unavailable"}`,
        `Override Existing Labels: ${overrideExisting ? "True" : "False"}`,
        `Source Labels: ${sourceCount ?? "Unavailable"}`,
        `Receiving Labels Before Transfer: ${initialTargetCount ?? "Unavailable"}`,
        `Repositories Affected: ${result.hasChanges ? 1 : 0}`,
        `Repositories Skipped: ${skippedRepositories.length}`,
        `Created Labels: ${result.createdLabels.length}`,
        `Updated Labels: ${result.updatedLabels.length}`,
        `Deleted Labels: ${result.deletedConfiguredLabels.length}`,
        `Retained Labels: ${failure || initialTargetCount === null ? "Unavailable" : retainedCount}`,
      ],
      sections: [renderLabelSyncSection(result)],
      skippedRepositories,
      failure,
    });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  transferLabels({
    token: process.env.LABEL_SYNC_TOKEN,
    organization: process.env.ORG_NAME ?? process.env.GITHUB_REPOSITORY_OWNER,
    sourceRepository: process.env.SOURCE_REPOSITORY,
    targetRepository: process.env.TARGET_REPOSITORY,
    dryRun: process.env.DRY_RUN === "true",
    overrideExisting: process.env.OVERRIDE_EXISTING === "true",
    tokenPermissions: parseTokenPermissions(process.env.LABEL_SYNC_TOKEN_PERMISSIONS),
  }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
