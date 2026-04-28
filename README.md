# Label Sync

This repository is a standalone GitHub label management repo for an organization.

Its job is to:

- keep this repo's label config in sync with the labels currently defined on the repo
- validate config changes automatically
- sync the resulting label set across the rest of the organization
- remove an exact label from issues and pull requests across the filtered repository set
- write run-level changelogs for each workflow run that actually changes another repository

## How It Works

This repo uses five workflows:

1. `Config-Label_Sync`
2. `Validate-Configs`
3. `Reverse-Config-Label-Sync`
4. `Org-Label-Sync`
5. `Remove-Labels`

The normal flow is:

1. You run `Org-Label-Sync` manually.
2. It first calls `Config-Label_Sync`.
3. `Config-Label_Sync` reads the labels on this repository and rewrites `config/labels.jsonc` so the file matches the repo's current labels.
4. If that file changed, `Config-Label_Sync` commits and pushes the update.
5. That config change triggers `Validate-Configs`.
6. `Org-Label-Sync` then checks out the latest default branch, validates the config again, and syncs labels across the organization.

The reverse flow is:

1. You make a non-bot commit to `config/**` on the default branch.
2. `Validate-Configs` runs for that commit.
3. If validation passes, `Reverse-Config-Label-Sync` updates the configured source repository labels from `config/labels.jsonc`.
4. Bot commits are ignored, so `Config-Label_Sync` can update `labels.jsonc` without triggering a reverse sync loop.

## Repository Layout

```text
.
|-- .github/
|   `-- workflows/
|       |-- config-label-sync.yml
|       |-- org-label-sync.yml
|       |-- remove-labels.yml
|       |-- reverse-config-label-sync.yml
|       `-- validate-configs.yml
|-- config/
|   |-- auto-pruned-labels.jsonc
|   |-- labels.jsonc
|   |-- properties.jsonc
|   `-- repository-filter.jsonc
|-- changelogs/
|   `-- YYYY-MM-DD/
|       `-- workflow-run-changelog.md
`-- scripts/
    |-- export-properties.mjs
    |-- remove-labels.mjs
    |-- reverse-config-label-sync.mjs
    |-- sync-config-labels.mjs
    |-- sync-labels.mjs
    `-- lib/
        |-- changelog-utils.mjs
        `-- config-utils.mjs
```

## Config Files

All config files live under `config/` and use `jsonc`, so they can include commented examples at the top.

### `config/properties.jsonc`

This is the general admin config for values that will differ between forks.

Fields:

- `organization`: the GitHub organization to sync
- `labelSyncTokenSecretName`: the name of the GitHub Actions secret containing the sync token
- `sourceRepository`: the repo whose labels are treated as the source for `Config-Label_Sync`
- `deleteMissingByDefault`: whether org sync should delete labels that are neither managed nor auto-pruned

Example:

```jsonc
{
  "organization": "your-org-name",
  "labelSyncTokenSecretName": "LABEL_SYNC_TOKEN",
  "sourceRepository": "your-org-name/label-sync",
  "deleteMissingByDefault": false
}
```

### `config/labels.jsonc`

This is the managed label set that gets created or updated across the org.

It is normally maintained automatically by `Config-Label_Sync`, based on the labels currently present on this repository.

Each label object uses:

- `name`
- `color`
- `description`

Example:

```jsonc
[
  {
    "name": "priority: high",
    "color": "b60205",
    "description": "Top-priority work"
  }
]
```

### `config/auto-pruned-labels.jsonc`

This is the list of exact labels that should be removed from synced repositories when they are not managed by `config/labels.jsonc`.

Each entry must include:

- `name`
- `color`
- `description`

The starter file is prefilled with GitHub's default labels as exact specs:

```jsonc
[
  {
    "name": "bug",
    "color": "d73a4a",
    "description": "Something isn't working"
  },
  {
    "name": "enhancement",
    "color": "a2eeef",
    "description": "New feature or request"
  }
]
```

`Org-Label-Sync` only deletes a configured auto-pruned label when the target repository label has the same name casing, color, and description. A custom label such as `Enhancement`, or an `enhancement` label with a different description or color, is not deleted by this file.

Managed labels are the source of truth. If a label exists in `config/labels.jsonc`, it is created or updated on target repositories and is not deleted by `config/auto-pruned-labels.jsonc`, even when it has the same name as an auto-pruned default.

### `config/repository-filter.jsonc`

This controls which repositories `Org-Label-Sync` will target.

The file uses:

- `useWhitelist`: when `true`, only repositories in `whitelist` are synced; when `false`, all discovered org repositories are synced except those in `blacklist`
- `whitelist`: repos to include when whitelist mode is enabled
- `blacklist`: repos to exclude when whitelist mode is disabled

`useWhitelist` defaults to `false`, so blacklist mode is the default behavior.

Entries in either list can be either:

- `repo-name`
- `owner/repo-name`

Example:

```jsonc
{
  "useWhitelist": false,
  "whitelist": [
    "sandbox-repo",
    "your-org-name/important-repo"
  ],
  "blacklist": [
    "do-not-touch",
    "your-org-name/private-internal-tools"
  ]
}
```

## Workflows

### `Config-Label_Sync`

File: `.github/workflows/config-label-sync.yml`

Trigger:

- manual via `workflow_dispatch`
- callable from other workflows via `workflow_call`

What it does:

1. Checks out the default branch
2. Loads shared settings from `config/properties.jsonc`
3. Reads the current labels on the source repository
4. Rewrites `config/labels.jsonc` so it exactly matches the source repository labels
5. Validates `config/auto-pruned-labels.jsonc` so exact default-delete specs remain well-formed
6. Commits and pushes the change if the config was updated

This workflow is the bridge between "the labels on this repo right now" and "the managed config we sync elsewhere."

### `Validate-Configs`

File: `.github/workflows/validate-configs.yml`

Trigger:

- runs automatically on `push` to `config/**`
- runs automatically on `pull_request` changes to `config/**`

What it does:

1. Checks out the repo
2. Runs `node scripts/validate-configs.mjs`

Validation includes:

- JSONC parsing
- required property checks
- duplicate label detection
- repository filter shape and `useWhitelist` validation
- duplicate whitelist and blacklist detection
- invalid colors
- invalid repo names
- exact auto-pruned label shape validation
- validation for the shared config used by `Remove-Labels`

### `Reverse-Config-Label-Sync`

File: `.github/workflows/reverse-config-label-sync.yml`

Trigger:

- after `Validate-Configs` completes successfully for a push to the default branch

What it does:

1. Checks out the exact commit that passed validation
2. Skips the run unless the triggering commit changed `config/**`
3. Skips the run when the triggering commit author or committer is a bot
4. Loads shared settings from `config/properties.jsonc`
5. Validates the config again as a local guard
6. Creates or updates source repository labels from `config/labels.jsonc`
7. Deletes exact auto-pruned labels and any other source repository labels that are not in `config/labels.jsonc`

This workflow is the bridge from "the managed config was changed by a person" back to "the source repository label settings should now match that config."

### `Org-Label-Sync`

File: `.github/workflows/org-label-sync.yml`

Trigger:

- manual via `workflow_dispatch`

Inputs:

- `dry_run`: preview changes without writing them
- `delete_missing`: override `deleteMissingByDefault` for the run
- `repositories`: optional comma-separated subset of repositories after `repository-filter.jsonc` is applied

What it does:

1. Calls `Config-Label_Sync`
2. Checks out the latest default branch
3. Loads shared settings from `config/properties.jsonc`
4. Validates the updated config
5. Discovers repos in the configured organization
6. Applies `config/repository-filter.jsonc`
7. Creates or updates labels from `config/labels.jsonc`
8. Deletes labels that exactly match entries in `config/auto-pruned-labels.jsonc` unless that label name is managed by `config/labels.jsonc`
9. Optionally deletes any other unmanaged labels if `delete_missing` or `deleteMissingByDefault` is enabled
10. If the run is not a dry run and at least one target repo changed, writes a changelog under `changelogs/YYYY-MM-DD/` and commits it with `[skip ci]`

### `Remove-Labels`

File: `.github/workflows/remove-labels.yml`

Trigger:

- manual via `workflow_dispatch`

Inputs:

- `run_on_issues`: remove the label from matching issues
- `target_only_closed_issues`: when `run_on_issues` is enabled, only target closed issues
- `run_on_pull_requests`: remove the label from matching pull requests
- `target_only_closed_pull_requests`: when `run_on_pull_requests` is enabled, only target closed pull requests
- `label_name`: exact label name to remove

What it does:

1. Checks out the latest default branch
2. Loads the org name and token secret name from `config/properties.jsonc`
3. Validates the shared config inputs used for repo discovery
4. Discovers repositories in the configured organization
5. Applies `config/repository-filter.jsonc` in whitelist or blacklist mode
6. Removes the exact label from the selected issues and/or pull requests in every remaining repository
7. If at least one target repo changed, writes a changelog under `changelogs/YYYY-MM-DD/` and commits it with `[skip ci]`

## Changelogs

Applied changes to other repositories are documented in `changelogs/`.

Each changelog file is created only when a workflow actually changes at least one filtered target repository. Repositories that were included by the whitelist or not excluded by the blacklist, but had nothing to change, are not listed.

`Org-Label-Sync` changelogs include:

- created labels
- updated labels, including changed fields
- configured auto-pruned labels that were deleted
- unmanaged labels that were deleted when delete-missing is enabled

`Remove-Labels` changelogs include:

- each issue the label was removed from
- each pull request the label was removed from

Changelog commits use the configured full-access token and include `[skip ci]` in the commit message so they do not trigger normal workflow/check runs.

Notes:

- GitHub Actions does not currently support conditionally hiding or nesting `workflow_dispatch` inputs, so the closed-only toggles can be described as dependent but not visually tucked under their parent checkboxes.

## Token Requirements

Create a repository secret whose name matches `labelSyncTokenSecretName` in `config/properties.jsonc`.

That token needs enough access to:

- read and update labels on the source repository
- discover repositories in the organization
- read and update labels on target repositories
- read and update labels on the source repository when running `Reverse-Config-Label-Sync`
- read and update issues and pull requests when running `Remove-Labels`
- push config updates back to this repository when `Config-Label_Sync` changes `labels.jsonc`
- push changelog commits back to this repository when an action changes another repository

## Setup

1. Fork or clone this repository into the organization you want to manage.
2. Create the sync token secret in the repo.
3. Update `config/properties.jsonc` for your org and repo.
4. Adjust `config/auto-pruned-labels.jsonc` if you want different exact default-delete specs.
5. Configure `config/repository-filter.jsonc` for blacklist mode or whitelist mode.
6. Set the labels on this repository to the label set you want to manage.
7. Run `Config-Label_Sync` once if you want to populate `config/labels.jsonc` immediately.
8. Run `Org-Label-Sync` to propagate the labels across the organization.

## Safe Defaults

- `labels.jsonc` starts empty until you define or sync labels on this repo
- all repos in the org are targeted unless excluded by `repository-filter.jsonc`
- GitHub default labels are auto-pruned by default only when they exactly match the stored name, color, and description and are not managed in `labels.jsonc`
- deleting unmanaged labels is off by default unless you enable it
