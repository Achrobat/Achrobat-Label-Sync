# Label Sync

This repository is a standalone GitHub label management repo for an organization.

Its job is to:

- keep this repo's label config in sync with the labels currently defined on the repo
- track labels removed from that source config so they can be deleted from synced repositories
- validate config changes automatically
- sync the resulting label set across the rest of the organization
- remove an exact label from issues and pull requests across the filtered repository set
- write run-level changelogs for each workflow run that actually changes another repository, plus fake changelogs for previewed org-label-sync and Remove-Labels changes

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
4. Any labels that were previously managed but are no longer on the source repository are moved to `config/deleted-labels.jsonc`.
5. If either config file changed, `Config-Label_Sync` commits and pushes the update.
6. That config change triggers `Validate-Configs`.
7. `Org-Label-Sync` then checks out the latest default branch, validates the config again, and syncs labels across the organization.

The reverse flow is:

1. You make a non-bot commit to `config/labels.jsonc` on the default branch.
2. `Reverse-Config-Label-Sync` runs its own validation guard.
3. If validation passes, it updates the configured source repository labels from `config/labels.jsonc`.
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
|   |-- deleted-labels.jsonc
|   |-- github-default-labels.jsonc
|   |-- labels.jsonc
|   |-- properties.jsonc
|   `-- repository-filter.jsonc
|-- changelogs/
|   `-- YYYY-MM-DD/
|       `-- workflow-run-changelog.md
|-- fake-changelogs/
|   `-- YYYY-MM-DD/
|       `-- workflow-run-changelog.md
`-- scripts/
    |-- export-properties.mjs
    |-- create-github-auth-token.mjs
    |-- remove-labels.mjs
    |-- reverse-config-label-sync.mjs
    |-- sync-config-labels.mjs
    |-- sync-labels.mjs
    `-- lib/
        |-- changelog-utils.mjs
        |-- config-validation.mjs
        `-- config-utils.mjs
```

## Config Files

All config files live under `config/` and use `jsonc`, so they can include commented examples at the top.

### `config/properties.jsonc`

This is the general admin config for values that will differ between forks.

Fields:

- `organization`: the GitHub organization to sync
- `authentication.mode`: `pat` or `githubApp`
- `authentication.pat.tokenSecretName`: the GitHub Actions secret containing the PAT when `mode` is `pat`
- `authentication.githubApp.appIdSecretName`: the GitHub Actions secret containing the GitHub App ID when `mode` is `githubApp`
- `authentication.githubApp.privateKeySecretName`: the GitHub Actions secret containing the GitHub App private key when `mode` is `githubApp`
- `authentication.githubApp.installationIdSecretName`: the GitHub Actions secret containing the GitHub App installation ID when `mode` is `githubApp`
- `sourceRepository`: the repo whose labels are treated as the source for `Config-Label_Sync`

Example:

```jsonc
{
  "organization": "your-org-name",
  "authentication": {
    "mode": "pat",
    "pat": {
      "tokenSecretName": "LABEL_SYNC_TOKEN"
    },
    "githubApp": {
      "appIdSecretName": "LABEL_SYNC_APP_ID",
      "privateKeySecretName": "LABEL_SYNC_APP_PRIVATE_KEY",
      "installationIdSecretName": "LABEL_SYNC_APP_INSTALLATION_ID"
    }
  },
  "sourceRepository": "your-org-name/label-sync"
}
```

To switch to GitHub App auth, set `authentication.mode` to `githubApp` and create secrets matching the three configured GitHub App secret names. The configured installation must have access to this configuration repository, the source repository, and every target repository selected by `repository-filter.jsonc`.

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

### `config/deleted-labels.jsonc`

This is the list of labels that should be deleted from synced repositories.

It is normally maintained automatically by `Config-Label_Sync`. When a label existed in `config/labels.jsonc` and is later removed from the source repository, the last managed label spec is moved here.

Each entry uses the same object shape as `config/labels.jsonc`:

- `name`
- `color`
- `description`

`Org-Label-Sync` deletes matching label names from target repositories regardless of color or description. If a label appears again on the source repository, `Config-Label_Sync` removes it from `config/deleted-labels.jsonc` and restores it to `config/labels.jsonc`.

### `config/github-default-labels.jsonc`

This is the list of exact GitHub default labels that can be removed from synced repositories when they are not managed by `config/labels.jsonc`.

You will likely never need to modify this file unless GitHub changes the default labels it creates for new repositories.

Each entry must include:

- `name`
- `color`
- `description`

The file is prefilled with GitHub's default labels as exact specs:

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

`Org-Label-Sync` only deletes an entry from this file when the `delete_github_default_labels` workflow checkbox is checked and the target repository label has the same name casing, color, and description. A custom label such as `Enhancement`, or an `enhancement` label with a different description or color, is not deleted as a GitHub default label.

Managed labels are the source of truth. If a label exists in `config/labels.jsonc`, it is created or updated on target repositories and is not deleted by `config/github-default-labels.jsonc`, even when it has the same name as a GitHub default label.

### `config/repository-filter.jsonc`

This controls which repositories `Org-Label-Sync` will target.

The file uses:

- `useWhitelist`: when `true`, only repositories in `whitelist` are synced; when `false`, all discovered org repositories are synced except those in `blacklist`
- `whitelist`: repos to include when whitelist mode is enabled
- `blacklist`: repos to exclude when whitelist mode is disabled

`useWhitelist` defaults to `false`, so blacklist mode is the default behavior.

The configured `sourceRepository` is always skipped by repository-filter processing. You do not need to add it to either list, and listing it in `whitelist` or `blacklist` will not make `Org-Label-Sync` or `Remove-Labels` target it.

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
3. Resolves either the configured PAT or a GitHub App installation token
4. Reads the current labels on the source repository
5. Rewrites `config/labels.jsonc` so it exactly matches the source repository labels
6. Moves any previously managed labels that are missing from the source repository into `config/deleted-labels.jsonc`
7. Validates `config/github-default-labels.jsonc` so exact GitHub default label specs remain well-formed
8. Commits and pushes the change if either config file was updated

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
- deleted-label shape and duplicate-name validation
- repository filter shape and `useWhitelist` validation
- duplicate whitelist and blacklist detection
- invalid colors
- invalid repo names
- exact GitHub default label shape validation
- validation for the shared config used by `Remove-Labels`

### `Reverse-Config-Label-Sync`

File: `.github/workflows/reverse-config-label-sync.yml`

Trigger:

- automatically on `push` to `config/labels.jsonc` on the default branch

What it does:

1. Checks out the triggering commit
2. Skips the run unless the triggering commit changed `config/labels.jsonc`
3. Skips the run when the triggering commit author or committer is a bot
4. Loads shared settings from `config/properties.jsonc`
5. Resolves either the configured PAT or a GitHub App installation token
6. Validates the config again as a local guard
7. Creates or updates source repository labels from `config/labels.jsonc`
8. Deletes exact GitHub default labels and any other source repository labels that are not in `config/labels.jsonc`

This workflow is the bridge from "the managed config was changed by a person" back to "the source repository label settings should now match that config."

### `Org-Label-Sync`

File: `.github/workflows/org-label-sync.yml`

Trigger:

- manual via `workflow_dispatch`

Inputs:

- `dry_run`: preview changes without applying repository label changes; when previewed changes exist, writes a fake changelog under `fake-changelogs/`
- `delete_missing`: delete extra labels that are not in `config/labels.jsonc`; unchecked keeps extra labels
- `delete_github_default_labels`: delete exact GitHub default labels from `config/github-default-labels.jsonc`; checked by default, unchecked keeps them
- `repositories`: comma-separated config override that runs exclusively on those non-source repositories and ignores `repository-filter.jsonc`
- `label_replacements`: optional comma-separated replacements in `old=new, old2=new2` format; each old label must exist in `config/deleted-labels.jsonc`, and each new label must exist in `config/labels.jsonc`

`label_replacements` is meant for renames. For example, `Enchantment=Enhancement` will replace `Enchantment` with `Enhancement` across selected repositories before the deleted-label pass removes old labels. If a target repo has `Enchantment` but does not yet have `Enhancement`, the workflow renames the repo label, which preserves issue and pull request assignments. If both labels already exist, it adds `Enhancement` to every issue and pull request that has `Enchantment`, then deletes `Enchantment`.

The `label_replacements` format uses `,` between pairs and the first `=` inside each pair, so label names used there cannot contain literal commas or equals signs.

What it does:

1. Calls `Config-Label_Sync`
2. Checks out the latest default branch
3. Loads shared settings from `config/properties.jsonc`
4. Resolves either the configured PAT or a GitHub App installation token
5. Validates the updated config
6. Discovers repos in the configured organization
7. Applies `config/repository-filter.jsonc`, unless `repositories` was provided as a workflow dispatch config override, and skips the configured source repository
8. Applies any requested `label_replacements`
9. Creates or updates labels from `config/labels.jsonc`
10. Deletes labels whose names match entries in `config/deleted-labels.jsonc`
11. Deletes labels that exactly match entries in `config/github-default-labels.jsonc` only when the `delete_github_default_labels` workflow checkbox is checked, unless that label name is managed by `config/labels.jsonc`
12. Optionally deletes any other unmanaged labels only when the `delete_missing` workflow checkbox is checked; exact GitHub default labels are reserved for `delete_github_default_labels`
13. If at least one target repo changed or would change, writes a changelog and commits it with `[skip ci]`; real runs write to `changelogs/YYYY-MM-DD/`, while preview runs write fake changelogs to `fake-changelogs/YYYY-MM-DD/` and do not apply repository changes

### `Remove-Labels`

File: `.github/workflows/remove-labels.yml`

Trigger:

- manual via `workflow_dispatch`

Inputs:

- `dry_run`: preview label removals without applying issue or pull request changes; when previewed removals exist, writes a fake changelog under `fake-changelogs/`
- `run_on_issues`: remove the label from matching issues
- `target_only_closed_issues`: when `run_on_issues` is enabled, only target closed issues
- `run_on_pull_requests`: remove the label from matching pull requests
- `target_only_closed_pull_requests`: when `run_on_pull_requests` is enabled, only target closed pull requests
- `label_name`: exact label name to remove
- `repositories`: comma-separated config override that runs exclusively on those non-source repositories and ignores `repository-filter.jsonc`

What it does:

1. Checks out the latest default branch
2. Loads the org name and auth settings from `config/properties.jsonc`
3. Resolves either the configured PAT or a GitHub App installation token
4. Validates the shared config inputs used for repo discovery
5. Discovers repositories in the configured organization
6. Applies `config/repository-filter.jsonc` in whitelist or blacklist mode, unless `repositories` was provided as a workflow dispatch config override, and skips the configured source repository
7. Removes the exact label from the selected issues and/or pull requests in every remaining repository
8. If at least one target repo changed or would change, writes a changelog and commits it with `[skip ci]`; real runs write to `changelogs/YYYY-MM-DD/`, while preview runs write fake changelogs to `fake-changelogs/YYYY-MM-DD/` and do not apply issue or pull request changes

## Changelogs

Applied changes to other repositories are documented in `changelogs/`. Previewed org-label-sync and Remove-Labels changes are documented in `fake-changelogs/`.

Each changelog file is created only when a workflow actually changes, or in preview mode would change, at least one target repository. Repositories that were selected but had nothing to change are not listed.

`Org-Label-Sync` changelogs include:

- created labels
- label replacements requested through `Org-Label-Sync`
- updated labels, including changed fields
- labels deleted by `config/deleted-labels.jsonc`
- GitHub default labels that were deleted
- unmanaged labels that were deleted when delete-missing is enabled

`Remove-Labels` changelogs include:

- each issue the label was removed from
- each pull request the label was removed from

Changelog commits use the resolved PAT or GitHub App installation token and include `[skip ci]` in the commit message so they do not trigger normal workflow/check runs.

Notes:

- GitHub Actions does not currently support conditionally hiding or nesting `workflow_dispatch` inputs, so the closed-only toggles can be described as dependent but not visually tucked under their parent checkboxes.

## Authentication Requirements

Set `authentication.mode` in `config/properties.jsonc` to choose how workflows authenticate.

For PAT auth, create a repository secret whose name matches `authentication.pat.tokenSecretName`.

That PAT needs enough access to:

- read and update labels on the source repository
- discover repositories in the organization
- read and update labels on target repositories
- read and update labels on the source repository when running `Reverse-Config-Label-Sync`
- read and update issues and pull requests when running `Remove-Labels` or `Org-Label-Sync` label replacements
- push config updates back to this repository when `Config-Label_Sync` changes `labels.jsonc` or `deleted-labels.jsonc`
- push changelog commits back to this repository when an action changes another repository

For GitHub App auth, create repository secrets whose names match:

- `authentication.githubApp.appIdSecretName`
- `authentication.githubApp.privateKeySecretName`
- `authentication.githubApp.installationIdSecretName`

The GitHub App installation must be granted access to this configuration repository, the source repository, and every target repository selected by the filter. Its permissions should cover repository metadata, contents write access for config/changelog commits, issues write access for label removal and label replacements, pull requests write access for label removal and label replacements, and repository administration or equivalent label-management access for creating, updating, and deleting labels.

## Setup

1. Fork or clone this repository into the organization you want to manage.
2. Create either the PAT secret or the GitHub App secrets in the repo.
3. Update `config/properties.jsonc` for your org, repo, and auth mode.
4. Leave `config/github-default-labels.jsonc` alone unless GitHub changes its default labels.
5. Configure `config/repository-filter.jsonc` for blacklist mode or whitelist mode.
6. Set the labels on this repository to the label set you want to manage.
7. Run `Config-Label_Sync` once if you want to populate `config/labels.jsonc` immediately.
8. Run `Org-Label-Sync` to propagate the labels across the organization.

## Safe Defaults

- `labels.jsonc` starts empty until you define or sync labels on this repo
- `deleted-labels.jsonc` starts empty and is populated when synced labels are removed from the source repository
- all repos in the org are targeted unless excluded by `repository-filter.jsonc`
- GitHub default labels are pruned by default when they exactly match `config/github-default-labels.jsonc`; uncheck `delete_github_default_labels` to keep them
- deleting unmanaged labels is off by default unless you check `delete_missing` when running `Org-Label-Sync`
