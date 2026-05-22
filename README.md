# DB Chat

DB Chat is a desktop AI chat workspace for databases. The MVP is an Electron + React + TypeScript app with SQLite and Elasticsearch support, SAFE-mode read-only execution, OpenRouter/OpenAI provider settings, and a three-pane chat/data/query layout.

## Run

```sh
npm install
npm run dev
```

The renderer is served at `http://127.0.0.1:5173/` and Electron opens the desktop shell.

## Verify

```sh
npm test
npm run typecheck
npm run build
```

Run verification before opening a pull request.

## Release

DB Chat releases are packaged with `electron-builder`. Pull requests into `main` need exactly one semantic version label: `major`, `minor`, or `patch`. When a labeled pull request merges, GitHub Actions creates the next semantic version tag from the latest `v<major>.<minor>.<patch>` tag on the merge commit.

1. Pull the latest changes before starting release branch work.
2. Label the pull request with exactly one of `major`, `minor`, or `patch`.
3. Run `npm test`, `npm run typecheck`, and `npm run build`.
4. Merge the change through a pull request and wait for the tag workflow to create the next version tag.
5. Create and publish a GitHub Release for that tag when binaries should be built.
6. Wait for the GitHub Actions release workflow to attach the packaged binaries, then smoke-test representative downloads.

Expected artifacts are macOS `.dmg` downloads for Apple Silicon and Intel, Windows NSIS installers for x64 and arm64, and Linux `AppImage` and `.deb` downloads for x64 and arm64. The first release path does not include in-app auto-update support.

Published GitHub Release tags are the packaged version source. `package.json` stays as the initial semantic version baseline if the repository does not have an existing semantic version tag yet.

For the smoke pass, launch the packaged app, open a SQLite database and run a SAFE read-only chat query, confirm the Elasticsearch connection path still reaches the packaged IPC layer, and confirm saved settings/API-key storage still works in packaged mode.

Unsigned macOS and Windows builds are allowed while signing credentials are not configured, but users will see the normal operating-system trust warnings for unsigned binaries. Add repository secrets for signing when they are available:

- macOS signing/notarization: `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID`.
- Windows signing: `WINDOWS_CSC_LINK` and `WINDOWS_CSC_KEY_PASSWORD`.

## MVP Notes

- SQLite opens database files in read-only mode.
- Elasticsearch connects with host, port, username/password, and TLS verification controls through the cluster HTTP API, introspects visible index mappings, and runs SAFE `_search` JSON requests. Password history is opt-in and uses Electron safe storage when remembered.
- SAFE mode is enabled by default and only permits allowlisted read-only SQLite queries or Elasticsearch searches.
- OpenRouter and OpenAI API keys are stored locally through Electron safe storage when available.
- MySQL and PostgreSQL are intentionally deferred behind connector interfaces.
