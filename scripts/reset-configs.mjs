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
  "label-test-workflow-config.jsonc": `// Central configuration for the Label Test reusable workflow and its caller workflow distributor.
// Plain names such as "UltraProdigy" are GitHub users.
// Names prefixed with "teams/" such as "teams/admin" are GitHub team slugs in config/properties.jsonc "organization".
{
  // If this list is empty, the required-label gate is disabled and any label state can pass this gate.
  // If this list has labels, a PR must have at least one of them.
  "requiredLabels": [
    // "Bug",
    // "Feature"
  ],

  // Any matching PR label in this list fails the check.
  "failingLabels": [
    // "Blocked",
    // "Do Not Merge"
  ],

  // Pull requests opened by these GitHub logins pass Label Test without applying label or approval rules.
  // If GitHub suppresses the initial pull_request_target event for a GITHUB_TOKEN-created PR, the success
  // status is posted after the existing review-refresh workflow receives a human review event.
  "ignoredPullRequestAuthors": [
    // "github-actions[bot]"
  ],

  // Add required or failing labels that apply only to one repository. Repository keys must use the
  // full "owner/repository" name. These lists are added to the organization-wide lists above.
  "repositoryLabels": {
    // "your-org-name/special-repo": {
    //   "requiredLabels": ["Repo Feature"],
    //   "failingLabels": ["Repo: Do Not Merge"]
    // }
  },

  // If a listed label is present on a PR, at least one listed user or team member for that label must have
  // latest effective review state APPROVED. List several approvers in one entry separated by commas.
  "protectedLabelApprovals": [
    // { "label": "Affects Balance", "approver": "teams/admin, UltraProdigy" }
  ],

  // Sticky labels stay on a PR once applied. If anyone other than a listed remover (user, team member, or
  // GitHub App bot login such as "my-app[bot]") takes one off, Label Test puts it straight back.
  // Combine with protectedLabelApprovals so the label cannot be removed to skip a required approval.
  // Removals made by Label Sync workflows such as Remove-Labels are always allowed. List several removers in
  // one entry separated by commas.
  "stickyLabels": [
    // { "label": "Affects Balance", "remover": "teams/admin, UltraProdigy" }
  ],

  // When true, the first time a sticky label is restored on a PR, Label Test posts a one-time comment naming
  // who can remove it. Later restorations of the same label on that PR do not comment again.
  "stickyLabelComment": false,

  // Review requests ask a user or team to review a PR that has the label. "when" picks the timing:
  //   "labeled" (default): request the reviewer as soon as the label is on the PR.
  //   "afterApproval": wait until someone with write access to the repository, who is not the reviewer (and
  //   not on the reviewer team), approves, then request the reviewer. Approvals from people without write
  //   access, such as contributors outside the organization, never count. If the reviewer has already
  //   approved, nothing is requested.
  // "approvedBy" (optional, afterApproval only) sets which approvals count in order to trigger the request,
  // as a comma-separated list of users or teams; they still need write access. Leave it out and any approval
  // from someone with write access outside the reviewer team triggers it. It only affects the request, not
  // whether Label Test passes; that is protectedLabelApprovals.
  // Nothing is requested on draft PRs. Each reviewer is requested once per label application or new
  // triggering approval, so a request removed by hand stays removed. If the label is removed, a pending
  // request made by Label Sync is withdrawn. Team reviewers need the configured PAT or GitHub App token,
  // and the team must have access to the repository.
  "reviewRequests": [
    // { "label": "Requires Admin", "reviewer": "teams/admin" },
    // { "label": "Affects Balance", "reviewer": "teams/balance-team", "when": "afterApproval" },
    // { "label": "Needs Art Review", "reviewer": "teams/art", "when": "afterApproval", "approvedBy": "teams/developers, UltraProdigy" }
  ],

  // Wait for merge: someone listed in "allowedUsers" comments "/wait-for-merge <link>" on a PR, where the link is
  // a PR URL, "owner/repo#123", or "#123". Label Test adds "label" until every linked PR is merged or closed,
  // then removes it and comments to tell the PR author and whoever ran the command that the PR is ready to
  // merge. Several commands stack. Removing the label by hand cancels the wait. "label" must also be listed in
  // "failingLabels" so it blocks merging, and it cannot be a sticky label. "allowExternalRepositories"
  // (default false) also allows links to PRs outside the organization. Leave "label" out to turn it off.
  "waitForMerge": {
    // "label": "Waiting on PR",
    // "allowedUsers": "teams/maintainers, UltraProdigy",
    // "allowExternalRepositories": false
  },

  // Chooses which repositories 05 - Distribute-Label-Workflow installs the Label Test workflows in. This is
  // separate from config/repository-filter.jsonc but uses the same format. The workflow's optional
  // "repositories" input overrides it for a single run.
  "workflowDistribution": {
    // "whitelist": only the repositories listed in "whitelist".
    // "blacklist": every discovered org repository except those listed in "blacklist".
    // "customProperty": repositories chosen by the rules in "customProperties". The Label Sync token needs the
    //                   organization "Custom properties" read permission for this mode.
    "filterMode": "whitelist",

    "whitelist": [
      // "sandbox-repo",
      // "your-org-name/important-repo"
    ],

    "blacklist": [
      // "do-not-touch",
      // "your-org-name/private-internal-tools"
    ],

    // "logic": "AND" means a repository must pass every rule, "OR" means it must pass at least one.
    // Each rule is one list: ["Property Name", "whitelist" or "blacklist", "Option", "Another Option", ...]
    //   "whitelist": the repository's value for the property must be one of the listed options.
    //   "blacklist": the repository's value must not be any of the listed options. Repositories with no value pass.
    // Options match the property value exactly, ignoring case. For true/false properties use "true" or "false".
    "customProperties": {
      "logic": "AND",
      "rules": [
        // ["Team", "whitelist", "Core", "Addons"],
        // ["Lifecycle", "blacklist", "Deprecated"]
      ]
    }
  }
}
`,
  "repository-filter.jsonc": `// "filterMode" chooses which repositories Label Sync works on:
//   "whitelist": only the repositories listed in "whitelist".
//   "blacklist": every discovered org repository except those listed in "blacklist".
//   "customProperty": repositories chosen by their organization custom property values, using the rules in
//                     "customProperties". The Label Sync token needs the organization "Custom properties" read
//                     permission for this mode.
// The configured source repository does not need to be listed here and is skipped even if listed.
{
  "filterMode": "whitelist",

  "automaticSync": {
    // Automatic Org-Label-Sync runs once daily. To change the frequency, edit the schedule in
    // .github/workflows/01-org-label-sync.yml.
    "enabled": false,
    "deleteMissing": false,
    "deleteGithubDefaultLabels": true,
    "labelReplacements": ""
  },

  // Used only when "filterMode" is "whitelist".
  "whitelist": [
    // "sandbox-repo",
    // "your-org-name/important-repo"
  ],

  // Used only when "filterMode" is "blacklist".
  "blacklist": [
    // "do-not-touch",
    // "your-org-name/private-internal-tools"
  ],

  // Used only when "filterMode" is "customProperty".
  // "logic" decides how several rules combine: "AND" means a repository must pass every rule, "OR" means it must
  // pass at least one.
  // Each rule is one list: ["Property Name", "whitelist" or "blacklist", "Option", "Another Option", ...]
  //   "whitelist": the repository's value for the property must be one of the listed options.
  //   "blacklist": the repository's value must not be any of the listed options. Repositories with no value pass.
  // Options match the property value exactly, ignoring case. For true/false properties use "true" or "false".
  // Property names and options are checked against the organization's custom properties when a workflow runs,
  // so a typo fails the run instead of selecting the wrong repositories.
  "customProperties": {
    "logic": "AND",
    "rules": [
      // ["Team", "whitelist", "Core", "Addons"],
      // ["Lifecycle", "blacklist", "Deprecated"]
    ]
  }
}
`,
};

const resetInputs = [
  ["RESET_DELETED_LABELS", "deleted-labels.jsonc"],
  ["RESET_GITHUB_DEFAULT_LABELS", "github-default-labels.jsonc"],
  ["RESET_LABELS", "labels.jsonc"],
  ["RESET_LABEL_TEST_WORKFLOW_CONFIG", "label-test-workflow-config.jsonc"],
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
