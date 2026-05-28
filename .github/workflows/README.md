# GitHub Actions workflows

One workflow per scheduled source. All share `./.github/actions/setup` for
Python + dependency setup.

## Conventions

- **One workflow per source.** Filename: `source-<source_id>.yml`.
- **Schedules in UTC** (GitHub Actions does not support local timezones).
  Annotate ET equivalent in a comment.
- **State commits**: each workflow ends by committing `state/` changes and
  pushing back to the working branch. Requires `permissions: contents: write`.
- **Concurrency**: `group: source-<source_id>` to prevent overlapping runs of
  the same source.
- **Secrets** (set under repo Settings -> Secrets and variables -> Actions):
  see `.env.example` at repo root.
- **Repo variables** (non-secret values): `R2_BUCKET`, `R2_ENDPOINT`,
  `SLACK_CHANNEL_SNAP`, `SLACK_CHANNEL_AUCTIONS`.

## Workflow files

- `source-namecheap-bin.yml` — example, first source we'll port.

Additional workflows land per source as we cut over from `legacy/openclaw/`.
