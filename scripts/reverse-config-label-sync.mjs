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
  validateDeleteLabels,
  validateLabels,
  validateProperties,
} from "./lib/config-validation.mjs";

const workspaceRoot = process.cwd();
const propertiesPath = path.join(workspaceRoot, "config", "properties.jsonc");
const labelsPath = path.join(workspaceRoot, "config", "labels.jsonc");
const autoPrunedLabelsPath = path.join(workspaceRoot, "config", "auto-pruned-labels.jsonc");

const validateOnly = process.argv.includes("--validate-only");
const dryRun = validateOnly || process.env.DRY_RUN === "true";

async function githubRequest(token, method, apiPath, body) {
  const response = await fetch(`https://api.github.com${apiPath}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "reverse-config-label-sync",
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

function isExactAutoPrunedLabel(label, deleteLabels) {
  return deleteLabels.some((deleteLabel) => labelsExactlyMatch(label, deleteLabel));
}

async function syncSourceRepository(token, repository, desiredLabels, deleteLabels) {
  console.log(`Syncing ${repository} labels from config`);
  const existingLabels = await getAllLabels(token, repository);
  const existingByName = new Map(existingLabels.map((label) => [normalizeName(label.name), label]));
  const desiredKeys = new Set(desiredLabels.map((label) => normalizeName(label.name)));

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
        await githubRequest(token, "POST", `/repos/${repository}/labels`, desired);
      }

      continue;
    }

    updated += 1;
    console.log(`  ~ ${desired.name}`);

    if (!dryRun) {
      await githubRequest(
        token,
        "PATCH",
        `/repos/${repository}/labels/${encodeURIComponent(existing.name)}`,
        desired,
      );
    }
  }

  for (const existing of existingLabels) {
    const existingKey = normalizeName(existing.name);

    if (desiredKeys.has(existingKey) || !isExactAutoPrunedLabel(existing, deleteLabels)) {
      continue;
    }

    deletedConfigured += 1;
    console.log(`  - ${existing.name} (configured delete)`);

    if (!dryRun) {
      await githubRequest(
        token,
        "DELETE",
        `/repos/${repository}/labels/${encodeURIComponent(existing.name)}`,
      );
    }
  }

  for (const existing of existingLabels) {
    const existingKey = normalizeName(existing.name);

    if (desiredKeys.has(existingKey) || isExactAutoPrunedLabel(existing, deleteLabels)) {
      continue;
    }

    deletedMissing += 1;
    console.log(`  - ${existing.name} (not in config)`);

    if (!dryRun) {
      await githubRequest(
        token,
        "DELETE",
        `/repos/${repository}/labels/${encodeURIComponent(existing.name)}`,
      );
    }
  }

  console.log(
    `Summary for ${repository}: created=${created}, updated=${updated}, deletedConfigured=${deletedConfigured}, deletedMissing=${deletedMissing}, unchanged=${unchanged}`,
  );
}

async function main() {
  const properties = validateProperties(await readJsonc(propertiesPath), {
    includeSourceRepository: true,
    defaultSourceRepository: process.env.GITHUB_REPOSITORY ?? "",
  });
  const labels = validateLabels(await readJsonc(labelsPath));
  const deleteLabels = validateDeleteLabels(await readJsonc(autoPrunedLabelsPath));
  const repository = process.env.SOURCE_REPOSITORY ?? properties.sourceRepository;
  assert(repository, "SOURCE_REPOSITORY or properties.sourceRepository is required.");

  console.log(
    `Loaded ${labels.length} managed labels and ${deleteLabels.length} exact auto-pruned label specs for ${repository}.`,
  );

  if (validateOnly) {
    console.log("Configuration is valid.");
    return;
  }

  const token = process.env.LABEL_SYNC_TOKEN;
  assert(token, "LABEL_SYNC_TOKEN is required unless --validate-only is used.");

  await syncSourceRepository(token, repository, labels, deleteLabels);

  if (dryRun) {
    console.log("Dry-run mode did not apply label changes.");
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
