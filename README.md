# Label Sync

Label Sync keeps GitHub labels consistent across an organization. One source repository holds the label set, which is exported into config files, validated, and synced to every selected repository.

It can also enforce pull request label rules across the organization, including required, failing, approval-protected, and sticky labels, through one reusable required check. Labels can also trigger review requests, and comment commands let maintainers hold a pull request until others merge (`/wait-for-merge`), cherry-pick it into other branches (`/cherry-pick`), release it when it merges (`/release`), and let people join or leave teams (`/team`).

## Documentation

- [Setup](docs/setup.md): get Label Sync running in your organization
- [Authentication](docs/authentication.md): set up a Personal Access Token or GitHub App
- [Configuration](docs/configuration.md): config files, safe defaults, and validation
- [Workflows](docs/workflows.md): sync, remove, inventory, transfer, and reset labels
- [Label Test](docs/label-test.md): pull request label rules, review requests, commands, and distributing the check to repositories

## License

This project is licensed under the [MIT License](LICENSE).
