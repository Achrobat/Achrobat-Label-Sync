# Setup

1. Fork or clone this repository into the GitHub organization you want to manage.
2. Follow the [authentication setup guide](authentication.md).
3. Update `config/properties.jsonc` with your organization, source repository, and authentication settings.
4. Configure `config/repository-filter.jsonc` to choose which repositories should be synced.
5. Set the labels on the source repository to the label set you want to manage.
6. Run `Config-Label-Sync` once to populate `config/labels.jsonc`.
7. Run `Org-Label-Sync` to apply the labels across the selected repositories.

See [Configuration](configuration.md) for what each config file controls and [Workflows](workflows.md) for how to run the sync.
