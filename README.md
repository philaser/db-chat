# DB Chat

DB Chat is a desktop AI chat workspace for databases. The MVP is an Electron + React + TypeScript app with SQLite support, SAFE-mode read-only execution, OpenRouter/OpenAI provider settings, and a three-pane chat/data/query layout.

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

## MVP Notes

- SQLite is the first complete connector and opens database files in read-only mode.
- SAFE mode is enabled by default and only permits allowlisted read-only SQLite queries.
- OpenRouter and OpenAI API keys are stored locally through Electron safe storage when available.
- Elasticsearch, MySQL, and PostgreSQL are intentionally deferred behind connector interfaces.
