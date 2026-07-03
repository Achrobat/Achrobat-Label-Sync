import fs from "node:fs/promises";
import path from "node:path";

const workspaceRoot = process.cwd();
const configDir = path.join(workspaceRoot, "config");

const configDefaults = {
  "deleted-labels.jsonc": `// Labels removed from config/labels.jsonc by Config-Label-Sync are moved here.
// Org-Label-Sync deletes matching label names from selected repositories.
//
// Example:
// [
//   {
//     "name": "status: stale",
//     "color": "ededed",
//     "description": "No recent activity"
//   }
// ]
[]
`,
  "github-default-labels.jsonc": `// GitHub's default label set rarely changes.
// You will likely never need to modify this file unless GitHub changes the default labels it creates for new repositories.
//
// Example:
// [
//   {
//     "name": "bug",
//     "color": "d73a4a",
//     "description": "Something isn't working"
//   }
// ]
[
  {
    "name": "bug",
    "color": "d73a4a",
    "description": "Something isn't working"
  },
  {
    "name": "documentation",
    "color": "0075ca",
    "description": "Improvements or additions to documentation"
  },
  {
    "name": "duplicate",
    "color": "cfd3d7",
    "description": "This issue or pull request already exists"
  },
  {
    "name": "enhancement",
    "color": "a2eeef",
    "description": "New feature or request"
  },
  {
    "name": "good first issue",
    "color": "7057ff",
    "description": "Good for newcomers"
  },
  {
    "name": "help wanted",
    "color": "008672",
    "description": "Extra attention is needed"
  },
  {
    "name": "invalid",
    "color": "e4e669",
    "description": "This doesn't seem right"
  },
  {
    "name": "question",
    "color": "d876e3",
    "description": "Further information is requested"
  },
  {
    "name": "wontfix",
    "color": "ffffff",
    "description": "This will not be worked on"
  }
]
`,
  "labels.jsonc": `// Example:
// [
//   {
//     "name": "priority: high",
//     "color": "b60205",
//     "description": "Top-priority work"
//   },
//   {
//     "name": "status: blocked",
//     "color": "fbca04",
//     "description": "Waiting on something external"
//   }
// ]
[]
`,
  "repository-filter.jsonc": `// Set to true to sync only the repositories listed in "whitelist".
// Set to false to sync every discovered org repository except those listed in "blacklist".
// The configured source repository does not need to be listed here and is skipped even if listed.
{
  "useWhitelist": true,

  // Used only when "useWhitelist" is true.
  "whitelist": [
    // "sandbox-repo",
    // "your-org-name/important-repo"
  ],

  // Used only when "useWhitelist" is false.
  "blacklist": [
    // "do-not-touch",
    // "your-org-name/private-internal-tools"
  ]
}
`,
};

const resetInputs = [
  ["RESET_DELETED_LABELS", "deleted-labels.jsonc"],
  ["RESET_GITHUB_DEFAULT_LABELS", "github-default-labels.jsonc"],
  ["RESET_LABELS", "labels.jsonc"],
  ["RESET_REPOSITORY_FILTER", "repository-filter.jsonc"],
];

function parseBoolean(value) {
  return String(value ?? "").toLowerCase() === "true";
}

async function main() {
  const selectedFiles = resetInputs
    .filter(([envName]) => parseBoolean(process.env[envName]))
    .map(([, fileName]) => fileName);

  if (selectedFiles.length === 0) {
    throw new Error("At least one config file must be selected for reset.");
  }

  await fs.mkdir(configDir, { recursive: true });

  for (const fileName of selectedFiles) {
    await fs.writeFile(path.join(configDir, fileName), configDefaults[fileName], "utf8");
    console.log(`Reset config/${fileName}`);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
