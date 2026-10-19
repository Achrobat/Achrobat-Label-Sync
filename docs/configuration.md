# Configuration

## Config files

All project config lives in `config/` and uses JSONC, so comments are allowed.

- `config/properties.jsonc`: organization, source repository, and authentication settings
- `config/labels.jsonc`: managed labels to create or update across the organization
- `config/deleted-labels.jsonc`: labels that should be deleted from target repositories
- `config/github-default-labels.jsonc`: exact GitHub default label specs that can be pruned
- `config/repository-filter.jsonc`: whitelist or blacklist rules for repository selection and automatic sync settings
- `config/label-test-workflow-config.jsonc`: PR label-test rules and separate caller workflow distribution repository lists

The configured source repository is always skipped by repository filtering. You do not need to add it to the whitelist or blacklist.

## Safe defaults

- `labels.jsonc` starts empty until labels are defined or synced from the source repository
- `deleted-labels.jsonc` starts empty and is populated when managed labels are removed from the source repository
- `repository-filter.jsonc` defaults to blacklist mode, which targets all discovered org repositories except listed exclusions
- Automatic organization sync is disabled by default; when enabled, unmanaged label deletion is off and exact GitHub default label deletion is on
- `Config-Reset` resets `repository-filter.jsonc` to empty whitelist mode, which targets no repositories until entries are added
- GitHub default labels are pruned only when they exactly match `config/github-default-labels.jsonc`
- Unmanaged label deletion is disabled unless `delete_missing` is enabled on `Org-Label-Sync`
- Archived repositories are skipped automatically. Workflows that write repository data also skip repositories where the workflow token only has read access.

## Validate-Configs

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
- Label Test user and `teams/<slug>` approver, sticky label remover, and review request reviewer syntax
- GitHub default label shape
- Shared config used by `Org-Label-Sync` and `Remove-Labels`

The Label Test rules in `config/label-test-workflow-config.jsonc` are described in [Label Test](label-test.md).
