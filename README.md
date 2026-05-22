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

## MVP Notes

- SQLite opens database files in read-only mode.
- Elasticsearch connects with host, port, username/password, and TLS verification controls through the cluster HTTP API, introspects visible index mappings, and runs SAFE `_search` JSON requests. Password history is opt-in and uses Electron safe storage when remembered.
- SAFE mode is enabled by default and only permits allowlisted read-only SQLite queries or Elasticsearch searches.
- OpenRouter and OpenAI API keys are stored locally through Electron safe storage when available.
- MySQL and PostgreSQL are intentionally deferred behind connector interfaces.
