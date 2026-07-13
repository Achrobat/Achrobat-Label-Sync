# Label Sync

Label Sync is a standalone GitHub label management repository for keeping labels consistent across an organization.

It treats one configured source repository as the label source of truth, exports those labels into config files, validates the config, and syncs the resulting label set to the rest of the selected repositories in the organization.

Features:

- Sync labels from a source repository into `config/labels.jsonc`
- Track removed managed labels in `config/deleted-labels.jsonc`
- Validate JSONC config files automatically on config changes and pull requests
- Create and update labels across selected organization repositories
- Optionally run the organization label sync automatically once per day
- Delete labels that were removed from the managed label set
- Optionally delete exact GitHub default labels
- Optionally delete unmanaged labels during org sync runs
- Rename labels across repositories while preserving issue and pull request assignments where possible
- Targeted soft label removal from issues and pull requests across selected repositories
- Inventory labels currently present across selected repositories
- Support whitelist or blacklist repository selection
- Reset selected config files back to default unconfigured versions
- Write changelogs to GitHub Actions workflow summaries for real workflow changes and dry-run previews
- Enforce centrally configured PR label requirements through a reusable required-check workflow
- Distribute PR label-test caller workflows to selected organization repositories

## How to setup

1. Fork or clone this repository into the GitHub organization you want to manage.
2. Follow the [authentication setup guide](https://github.com/UltraProdigy/Label-Sync/wiki/Setting-Up-Authentication-For-Label%E2%80%90Sync).
3. Update `config/properties.jsonc` with your organization, source repository, and authentication settings.
4. Configure `config/repository-filter.jsonc` to choose which repositories should be synced.
5. Set the labels on the source repository to the label set you want to manage.
6. Run `Config-Label-Sync` once to populate `config/labels.jsonc`.
7. Run `Org-Label-Sync` to apply the labels across the selected repositories.

### Config files

All project config lives in `config/` and uses JSONC, so comments are allowed.

- `config/properties.jsonc`: organization, source repository, and authentication settings
- `config/labels.jsonc`: managed labels to create or update across the organization
- `config/deleted-labels.jsonc`: labels that should be deleted from target repositories
- `config/github-default-labels.jsonc`: exact GitHub default label specs that can be pruned
- `config/repository-filter.jsonc`: whitelist or blacklist rules for repository selection and automatic sync settings
- `config/label-test-workflow-config.jsonc`: PR label-test rules and separate caller workflow distribution repository lists

The configured source repository is always skipped by repository filtering. You do not need to add it to the whitelist or blacklist.

### Safe defaults

- `labels.jsonc` starts empty until labels are defined or synced from the source repository
- `deleted-labels.jsonc` starts empty and is populated when managed labels are removed from the source repository
- `repository-filter.jsonc` defaults to blacklist mode, which targets all discovered org repositories except listed exclusions
- Automatic organization sync is disabled by default; when enabled, unmanaged label deletion is off and exact GitHub default label deletion is on
- `Config-Reset` resets `repository-filter.jsonc` to empty whitelist mode, which targets no repositories until entries are added
- GitHub default labels are pruned only when they exactly match `config/github-default-labels.jsonc`
- Unmanaged label deletion is disabled unless `delete_missing` is enabled on `Org-Label-Sync`
- Archived repositories are skipped automatically. Workflows that write repository data also skip repositories where the workflow token only has read access.

## How to use the workflows

This repository includes nine GitHub Actions workflows:

- `02 - Config-Label-Sync`
- `Config-Reset`
- `05 - Distribute-Label-Workflow`
- `03 - Inventory-Labels`
- `97 - Label Test`
- `Validate-Configs`
- `Reverse-Config-Label-Sync`
- `01 - Org-Label-Sync`
- `04 - Remove-Labels`

### Recommended sync flow

Use this flow when the source repository labels are the source of truth.

1. Edit labels directly on the configured source repository.
2. Run `Config-Label-Sync`, or run `Org-Label-Sync` and let it call `Config-Label-Sync` first.
3. Review the generated changes to `config/labels.jsonc` and `config/deleted-labels.jsonc`.
4. Run `Org-Label-Sync` to apply the managed label set to the selected repositories.

`Config-Label-Sync` reads the current labels on the source repository, rewrites `config/labels.jsonc`, moves removed managed labels into `config/deleted-labels.jsonc`, validates the default-label config, and commits the config update when something changed.

### Config-first flow

Use this flow when you want to edit the managed label config directly.

1. Edit `config/labels.jsonc`.
2. Push the change to the default branch.
3. Let `Validate-Configs` verify the config.
4. Let `Reverse-Config-Label-Sync` update the source repository labels from the config.

`Reverse-Config-Label-Sync` ignores bot commits so automated config updates do not trigger a reverse sync loop.

### Org-Label-Sync

Run `Org-Label-Sync` manually when you want to apply the managed label set across selected repositories.

Inputs:

- `dry_run`: preview changes without applying them
- `delete_missing`: delete labels that are not managed by `config/labels.jsonc`
- `delete_github_default_labels`: delete exact GitHub default labels listed in `config/github-default-labels.jsonc`
- `repositories`: comma-separated override for the target repository list
- `label_replacements`: comma-separated rename map in `old=new, old2=new2` format

`label_replacements` is meant for label renames. The new label must exist in `config/labels.jsonc`. The old label must exist in `config/deleted-labels.jsonc`, or it may exist in `config/github-default-labels.jsonc` when `delete_github_default_labels` is enabled.

The workflow also checks for automatic runs every day at midnight UTC. Configure scheduled behavior in the `automaticSync` object in `config/repository-filter.jsonc`:

```jsonc
"automaticSync": {
  "enabled": false,
  "deleteMissing": false,
  "deleteGithubDefaultLabels": true,
  "labelReplacements": ""
}
```

Set `enabled` to `true` to allow the daily run. `labelReplacements` uses the same `old=new, old2=new2` format as the manual input. The schedule itself must be changed in `.github/workflows/01-org-label-sync.yml` because GitHub evaluates workflow schedules before loading repository config.

Automatic runs perform the normal full organization sync after applying the configured whitelist or blacklist. Repositories that already match remain unchanged, new repositories receive the managed labels, and label drift in existing repositories is corrected.

When changes are made, the workflow writes the changelog Markdown directly to the GitHub Actions workflow run summary. Dry runs use the same summary format and are marked as test-mode output. If the run fails after processing some repositories, the workflow still writes the accumulated changelog before failing. Workflow summaries are retained according to GitHub Actions run retention settings.

### Remove-Labels

Run `Remove-Labels` manually when you want to remove one exact label from issues and pull requests across selected repositories.

Inputs:

- `dry_run`: preview removals without applying them
- `run_on_issues`: remove the label from matching issues
- `target_only_closed_issues`: only target closed issues
- `run_on_pull_requests`: remove the label from matching pull requests
- `target_only_closed_pull_requests`: only target closed pull requests
- `label_name`: exact label name to remove
- `repositories`: comma-separated override for the target repository list

Like `Org-Label-Sync`, changelog Markdown is written directly to the GitHub Actions workflow run summary. Dry runs use the same summary format and are marked as test-mode output. If the run fails after processing some repositories, the workflow still writes the accumulated changelog before failing.

### Inventory-Labels

Run `Inventory-Labels` manually when you want an inventory of labels currently present on selected repositories.

Inputs:

- `exclude_configured_labels`: exclude labels whose name, color, and description exactly match a label in `config/labels.jsonc`
- `list_similarities`: append a shared-label count and a section listing exact label specs shared by two or more selected repositories, with each matching repository listed under the label
- `repositories`: comma-separated override for the target repository list

Inventory skips archived repositories, but keeps non-archived read-only repositories because inventory does not write to them. If the run fails after inventorying some repositories, the workflow still writes the accumulated inventory summary before failing.

### 97 - Label Test

`97 - Label Test` is a reusable workflow that target repositories can call from a small caller workflow. It is intended to be added as a required branch protection check on pull requests.

The rules live only in `config/label-test-workflow-config.jsonc` in this repository:

```jsonc
{
  "requiredLabels": [
    // "Bug",
    // "Feature"
  ],
  "failingLabels": [
    // "Blocked",
    // "Do Not Merge"
  ],
  "protectedLabelApprovals": [
    // { "label": "Affects Balance", "approver": "teams/admin" },
    // { "label": "Affects Balance", "approver": "UltraProdigy" }
  ],
  "workflowDistribution": {
    "whitelist": [],
    "blacklist": []
  }
}
```

Behavior:

- If `requiredLabels` is empty, the required-label gate is disabled and the check can pass with any labels or no labels.
- If `requiredLabels` has entries, a PR must have at least one matching label.
- Any matching `failingLabels` entry fails the check.
- Failing labels override required labels.
- If a protected label is present, at least one configured approver for that label must have latest effective review state `APPROVED`.
- Plain approvers such as `UltraProdigy` are GitHub users.
- Approvers prefixed with `teams/`, such as `teams/admin`, are GitHub team slugs in the configured organization.

For team approval checks, the workflow token must be able to read the configured organization team membership. The same `properties.authentication` setup used by the label sync workflows is used for the reusable Label Test workflow.

### 05 - Distribute-Label-Workflow

Run `05 - Distribute-Label-Workflow` manually to install or update the caller workflow in selected repositories. It writes `.github/workflows/label-test.yml` in each selected target repository. The generated caller workflow calls back to the repository and default branch that ran the distributor, so forks distribute callers that point to the fork.

Inputs:

- `dry_run`: preview without writing
- `repository_selection_mode`: choose `whitelist` or `blacklist` from `config/label-test-workflow-config.jsonc`
- `delivery_mode`: choose `Direct Commit` or `Pull Request`
- `repositories`: optional comma-separated repository override, such as `repo-one, org/repo-two`

When `repositories` is provided, it takes priority over `repository_selection_mode` and runs only on the listed non-source repositories.

`Pull Request` mode reuses the stable branch `label-sync/update-label-test-workflow` in each target repository and opens a PR if one does not already exist. Re-running the distributor updates the existing branch and PR.

The distributor skips archived repositories, empty repositories with no default-branch commit, and repositories whose available token permissions cannot perform the selected delivery mode. It then completes the branch, workflow commit, and pull request for one repository before starting the next. The first unexpected operational failure stops the run; rerunning it reuses any branch, commit, or pull request already created and continues without requiring branch cleanup.

After the caller workflow is merged into a target repository, make the `97 - Label Test` check required in that repository's branch protection rules.

### Config-Reset

Run `Config-Reset` manually when you want to restore selected config files to their default unconfigured versions.

Inputs:

- `reset_deleted_labels`: reset `config/deleted-labels.jsonc` to an empty deleted-label list
- `reset_github_default_labels`: reset `config/github-default-labels.jsonc` to the standard GitHub default label specs
- `reset_labels`: reset `config/labels.jsonc` to an empty managed-label list
- `reset_label_test_workflow_config`: reset `config/label-test-workflow-config.jsonc` to empty label-test rules and empty workflow distribution lists
- `reset_repository_filter`: reset `config/repository-filter.jsonc` to empty whitelist mode with automatic sync disabled
- `confirmation`: must be exactly `CONFIRM` (will fail otherwise)

`reset_labels` clears the managed label source of truth. The reset commit is made by `github-actions[bot]`, so `Reverse-Config-Label-Sync` ignores it.

### Validate-Configs

`Validate-Configs` runs automatically when config files change.

Validation checks include:

- JSONC parsing
- Required fields
- Duplicate labels
- Invalid label colors
- Invalid repository names
- Repository filter shape
- Automatic sync setting types and label replacement syntax
- Label Test workflow config shape
- Label Test user and `teams/<slug>` approver syntax
- GitHub default label shape
- Shared config used by `Org-Label-Sync` and `Remove-Labels`

## Wiki links [WIP]

- [Setup guide]()
- [Authentication setup](https://github.com/UltraProdigy/Label-Sync/wiki/Setting-Up-Authentication-For-Label%E2%80%90Sync)
- [Workflow guide]()
- [Configuration reference]()

## About

Label Sync is designed for organizations that want one consistent label system across many repositories without manually editing every repo.

This was initially based on a GHA workflow that I wrote in 2025 but was transitioned into a repository to account for increased complexity. The initial transition and all commits afterwards were aided by AI and underwent human review.

## License

This project is licensed under the [MIT License](LICENSE).
