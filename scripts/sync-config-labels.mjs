import path from "node:path";
import {
  assert,
  normalizeColor,
  normalizeDescription,
  normalizeName,
  readJsonc,
  writeJsoncPreservingHeader,
} from "./lib/config-utils.mjs";

const workspaceRoot = process.cwd();
const propertiesPath = path.join(workspaceRoot, "config", "properties.jsonc");
const labelsPath = path.join(workspaceRoot, "config", "labels.jsonc");
const autoPrunedLabelsPath = path.join(workspaceRoot, "config", "auto-pruned-labels.jsonc");

function validateProperties(properties) {
  assert(properties && typeof properties === "object" && !Array.isArray(properties), "config/properties.jsonc must contain an object.");

  if (properties.sourceRepository !== undefined) {
    assert(
      typeof properties.sourceRepository === "string" && /^[^/\s]+\/[^/\s]+$/.test(properties.sourceRepository.trim()),
      "properties.sourceRepository must match owner/repo when provided.",
    );
  }

  return {
    sourceRepository: (properties.sourceRepository ?? process.env.GITHUB_REPOSITORY ?? "").trim(),
  };
}

function validateDeleteLabels(deleteLabels) {
  assert(Array.isArray(deleteLabels), "config/auto-pruned-labels.jsonc must contain an array.");

  const seen = new Set();

  return new Set(
    deleteLabels.map((entry, index) => {
      assert(typeof entry === "string" && entry.trim(), `Delete label at index ${index} must be a non-empty string.`);

      const name = normalizeName(entry);
      assert(!seen.has(name), `Duplicate delete label detected: "${entry}".`);
      seen.add(name);
      return name;
    }),
  );
}

async function githubRequest(token, method, apiPath) {
  const response = await fetch(`https://api.github.com${apiPath}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "label-sync-config",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`${method} ${apiPath} failed with ${response.status}: ${message}`);
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

function toManagedLabels(labels, deleteLabels) {
  return labels
    .filter((label) => !deleteLabels.has(normalizeName(label.name)))
    .map((label) => ({
      name: label.name.trim(),
      color: normalizeColor(label.color),
      description: normalizeDescription(label.description),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

async function main() {
  const token = process.env.CONFIG_LABEL_SYNC_TOKEN ?? process.env.GITHUB_TOKEN;
  assert(token, "CONFIG_LABEL_SYNC_TOKEN or GITHUB_TOKEN is required.");

  const properties = validateProperties(await readJsonc(propertiesPath));
  const repository = process.env.SOURCE_REPOSITORY ?? properties.sourceRepository;
  assert(repository, "SOURCE_REPOSITORY or GITHUB_REPOSITORY is required.");

  const deleteLabels = validateDeleteLabels(await readJsonc(autoPrunedLabelsPath));
  const repositoryLabels = await getAllLabels(token, repository);
  const managedLabels = toManagedLabels(repositoryLabels, deleteLabels);

  await writeJsoncPreservingHeader(labelsPath, managedLabels);

  console.log(
    `Synced ${managedLabels.length} managed labels from ${repository} into config/labels.jsonc after excluding ${deleteLabels.size} auto-pruned labels.`,
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
