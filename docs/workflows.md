# Workflows

This repository includes eleven operational GitHub Actions workflows:

- `02 - Config-Label-Sync`
- `Config-Reset`
- `05 - Distribute-Label-Workflow`
- `03 - Inventory-Labels`
- `Refresh Label Test After Review`
- `Label Test`
- `Validate-Configs`
- `Reverse-Config-Label-Sync`
- `01 - Org-Label-Sync`
- `04 - Remove-Labels`
- `06 - Transfer-Labels`

`Label Test`, `Refresh Label Test After Review`, and `05 - Distribute-Label-Workflow` are covered in [Label Test](label-test.md). `Validate-Configs` is covered in [Configuration](configuration.md).

## Recommended sync flow

Use this flow when the source repository labels are the source of truth.

1. Edit labels directly on the configured source repository.
2. Run `Config-Label-Sync`, or run `Org-Label-Sync` and let it call `Config-Label-Sync` first.
3. Review the generated changes to `config/labels.jsonc` and `config/deleted-labels.jsonc`.
4. Run `Org-Label-Sync` to apply the managed label set to the selected repositories.

`Config-Label-Sync` reads the current labels on the source repository, rewrites `config/labels.jsonc`, moves removed managed labels into `config/deleted-labels.jsonc`, validates the default-label config, and commits the config update when something changed.

## Config-first flow

Use this flow when you want to edit the managed label config directly.

1. Edit `config/labels.jsonc`.
2. Push the change to the default branch.
3. Let `Validate-Configs` verify the config.
4. Let `Reverse-Config-Label-Sync` update the source repository labels from the config.

`Reverse-Config-Label-Sync` ignores bot commits so automated config updates do not trigger a reverse sync loop.

## Org-Label-Sync

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

## Remove-Labels

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

## Inventory-Labels

Run `Inventory-Labels` manually when you want an inventory of labels currently present on selected repositories.

Inputs:

- `exclude_configured_labels`: exclude labels whose name, color, and description exactly match a label in `config/labels.jsonc`
- `list_similarities`: append a shared-label count and a section listing exact label specs shared by two or more selected repositories, with each matching repository listed under the label
- `repositories`: comma-separated override for the target repository list

Inventory skips archived repositories, but keeps non-archived read-only repositories because inventory does not write to them. If the run fails after inventorying some repositories, the workflow still writes the accumulated inventory summary before failing.

## 06 - Transfer-Labels

Run `06 - Transfer-Labels` manually to copy all label names, colors, and descriptions directly from one repository to another.

Inputs, in workflow form order:

- `dry_run`: the first checkbox, off by default; previews the transfer in the workflow summary without modifying either repository
- `override_existing`: off by default; makes the receiving repository's labels match the source exactly, including updating matching labels and deleting any labels absent from the source
- `source_repository`: starting repository, as `repo-name` or `owner/repo-name`
- `target_repository`: receiving repository, as `repo-name` or `owner/repo-name`

Short names use the organization in `config/properties.jsonc`. Full names may reference other owners when the configured token can access both repositories. The workflow uses the existing PAT or GitHub App authentication settings and needs label write access to the receiving repository.

With override unchecked, the workflow only creates labels whose names are missing from the receiving repository. Existing labels keep their current names, colors, and descriptions, including when the source has a matching name with different capitalization. With override checked, matching labels are updated in place to preserve their issue and pull request assignments. Labels absent from the source are deleted after all additions and updates succeed; deleting those labels also removes their existing assignments. An empty source deletes all receiving labels only when override is checked.

Both inputs select repositories directly, independently of the configured sync source and repository filters. The source is only read, and selecting the same repository for both inputs is rejected. Archived receiving repositories are skipped; read-only receiving repositories are skipped for live transfers but can be previewed in test mode.

Override mode stops before any changes if the receiving repository has a label named `.` or `..`, because those names cannot be safely addressed through the label API's URL path.

Transfers pause at least one second between label writes to reduce GitHub secondary rate limits. When GitHub rejects a request due to rate limiting, the workflow logs the wait and retries up to five times, honoring `Retry-After` and exhausted primary-limit reset headers. Retry waits start at one minute and grow exponentially; GitHub's headers can require a longer pause. A transfer creating 233 labels takes roughly four minutes plus API response time and any rate-limit waits. Permission, validation, and ambiguous network/server errors still stop the run. Rerun a partially completed transfer with the same inputs to finish the remaining changes.

The workflow uses the Org-Label-Sync changelog layout in the GitHub Actions run summary, showing the source and receiving repositories, test and override settings, starting label counts, and created, updated, deleted, and retained counts. Retained labels are existing receiving labels left unchanged. Preview changelogs are marked as test-mode output. If the transfer fails partway through, the summary records completed changes and the failure; rerunning continues from the current label state.

## Config-Reset

Run `Config-Reset` manually when you want to restore selected config files to their default unconfigured versions.

Inputs:

- `reset_deleted_labels`: reset `config/deleted-labels.jsonc` to an empty deleted-label list
- `reset_github_default_labels`: reset `config/github-default-labels.jsonc` to the standard GitHub default label specs
- `reset_labels`: reset `config/labels.jsonc` to an empty managed-label list
- `reset_label_test_workflow_config`: reset `config/label-test-workflow-config.jsonc` to empty label-test rules and empty workflow distribution lists
- `reset_repository_filter`: reset `config/repository-filter.jsonc` to empty whitelist mode with automatic sync disabled
- `confirmation`: must be exactly `CONFIRM` (will fail otherwise)

`reset_labels` clears the managed label source of truth. The reset commit is made by `github-actions[bot]`, so `Reverse-Config-Label-Sync` ignores it.
