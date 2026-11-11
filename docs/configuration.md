# Configuration

## Config files

All project config lives in `config/` and uses JSONC, so comments are allowed.

- `config/properties.jsonc`: organization, source repository, and authentication settings
- `config/labels.jsonc`: managed labels to create or update across the organization
- `config/deleted-labels.jsonc`: labels that should be deleted from target repositories
- `config/github-default-labels.jsonc`: exact GitHub default label specs that can be pruned
- `config/repository-filter.jsonc`: whitelist, blacklist, or custom property rules for repository selection and automatic sync settings
- `config/label-test-workflow-config.jsonc`: PR label-test rules and separate caller workflow distribution repository lists

The configured source repository is always skipped by repository filtering. You do not need to add it to the whitelist or blacklist.

## Repository filter

`filterMode` in `config/repository-filter.jsonc` chooses which repositories `Org-Label-Sync`, `Inventory-Labels`, and `Remove-Labels` work on:

- `whitelist`: only the repositories listed in `whitelist`
- `blacklist`: every discovered organization repository except those listed in `blacklist`
- `customProperty`: repositories chosen by their organization custom property values, using the rules in `customProperties`

```jsonc
"filterMode": "customProperty",
"customProperties": {
  "logic": "AND",
  "rules": [
    ["Team", "whitelist", "Core", "Addons"],
    ["Lifecycle", "blacklist", "Deprecated"]
  ]
}
```

Each rule is one list: the property name, `whitelist` or `blacklist`, then one or more options.

- A `whitelist` rule passes when the repository's value is one of the listed options.
- A `blacklist` rule passes when the repository's value is none of the listed options. Repositories with no value for the property pass.
- `logic` combines rules: `AND` requires every rule to pass, `OR` requires at least one.
- Property names and options are compared without case sensitivity. Multi-select properties pass a `whitelist` rule when any selected value is listed. True/false properties use `"true"` or `"false"`. Unset properties use the organization's default value when one exists.

When a workflow runs in `customProperty` mode, it reads the organization's custom property definitions and fails if a rule names a property that does not exist or an option that is not one of a select property's allowed values. That keeps a typo from selecting nothing in a `whitelist` rule or everything in a `blacklist` rule. This mode needs the organization **Custom properties: Read** permission on the Label Sync token; see [Authentication](authentication.md).

The workflow `repositories` input still overrides the configured filter for a single run.

`workflowDistribution` in `config/label-test-workflow-config.jsonc` uses the same `filterMode`, `whitelist`, `blacklist`, and `customProperties` format for `05 - Distribute-Label-Workflow`. It defaults to `whitelist` when `filterMode` is omitted.

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
- Repository filter shape, `filterMode`, and custom property rule shape
- Automatic sync setting types and label replacement syntax
- Label Test workflow config shape
- Label Test user and `teams/<slug>` approver, sticky label remover, and review request reviewer syntax
- GitHub default label shape
- Shared config used by `Org-Label-Sync` and `Remove-Labels`

The Label Test rules in `config/label-test-workflow-config.jsonc` are described in [Label Test](label-test.md).
