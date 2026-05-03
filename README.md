# Label Sync

Label Sync is a standalone GitHub label management repository for keeping labels consistent across an organization.

It treats one configured source repository as the label source of truth, exports those labels into config files, validates the config, and syncs the resulting label set to the rest of the selected repositories in the organization.

Features:

- Sync labels from a source repository into `config/labels.jsonc`
- Track removed managed labels in `config/deleted-labels.jsonc`
- Validate JSONC config files automatically on config changes and pull requests
- Create and update labels across selected organization repositories
- Delete labels that were removed from the managed label set
- Optionally delete exact GitHub default labels
- Optionally delete unmanaged labels during org sync runs
- Rename labels across repositories while preserving issue and pull request assignments where possible
- Targeted soft label removal from issues and pull requests across selected repositories
- Support whitelist or blacklist repository selection
- Write changelogs for real workflow changes and fake changelogs for dry runs

## How to setup

1. Fork or clone this repository into the GitHub organization you want to manage.
2. Follow the [authentication setup guide](https://github.com/UltraProdigy/Label-Sync/wiki/Setting-Up-Authentication-For-Label%E2%80%90Sync).
3. Update `config/properties.jsonc` with your organization, source repository, and authentication settings.
4. Configure `config/repository-filter.jsonc` to choose which repositories should be synced.
5. Set the labels on the source repository to the label set you want to manage.
6. Run `Config-Label_Sync` once to populate `config/labels.jsonc`.
7. Run `Org-Label-Sync` to apply the labels across the selected repositories.

### Config files

All project config lives in `config/` and uses JSONC, so comments are allowed.

- `config/properties.jsonc`: organization, source repository, and authentication settings
- `config/labels.jsonc`: managed labels to create or update across the organization
- `config/deleted-labels.jsonc`: labels that should be deleted from target repositories
- `config/github-default-labels.jsonc`: exact GitHub default label specs that can be pruned
- `config/repository-filter.jsonc`: whitelist or blacklist rules for repository selection

The configured source repository is always skipped by repository filtering. You do not need to add it to the whitelist or blacklist.

### Safe defaults

- `labels.jsonc` starts empty until labels are defined or synced from the source repository
- `deleted-labels.jsonc` starts empty and is populated when managed labels are removed from the source repository
- `repository-filter.jsonc` defaults to blacklist mode, which targets all discovered org repositories except listed exclusions
- GitHub default labels are pruned only when they exactly match `config/github-default-labels.jsonc`
- Unmanaged label deletion is disabled unless `delete_missing` is enabled on `Org-Label-Sync`

## How to use the workflows

This repository includes five GitHub Actions workflows:

- `Config-Label_Sync`
- `Validate-Configs`
- `Reverse-Config-Label-Sync`
- `Org-Label-Sync`
- `Remove-Labels`

### Recommended sync flow

Use this flow when the source repository labels are the source of truth.

1. Edit labels directly on the configured source repository.
2. Run `Config-Label_Sync`, or run `Org-Label-Sync` and let it call `Config-Label_Sync` first.
3. Review the generated changes to `config/labels.jsonc` and `config/deleted-labels.jsonc`.
4. Run `Org-Label-Sync` to apply the managed label set to the selected repositories.

`Config-Label_Sync` reads the current labels on the source repository, rewrites `config/labels.jsonc`, moves removed managed labels into `config/deleted-labels.jsonc`, validates the default-label config, and commits the config update when something changed.

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

`label_replacements` is meant for label renames. The old label must exist in `config/deleted-labels.jsonc`, and the new label must exist in `config/labels.jsonc`.

When changes are made, the workflow writes changelogs under `changelogs/YYYY-MM-DD/`. Dry runs write preview changelogs under `fake-changelogs/YYYY-MM-DD/`.

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

Like `Org-Label-Sync`, real changes are written to `changelogs/` and dry-run previews are written to `fake-changelogs/`.

### Validate-Configs

`Validate-Configs` runs automatically when config files change.

Validation checks include:

- JSONC parsing
- Required fields
- Duplicate labels
- Invalid label colors
- Invalid repository names
- Repository filter shape
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
