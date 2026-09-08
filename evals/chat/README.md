# Chat evaluation

Run `npm run eval:chat` for reproducible query/tool contracts against a disposable synthetic SQLite database. This makes no model requests. It verifies numeric results, empty/NULL handling, join fanout, bounded result evidence, and chart hydration. The scripted model already knows the SQL: a pass does **not** establish natural-language reasoning quality.

Run `npm run eval:chat -- --live --limit 6` for actual model behavior using `DBCHAT_WEB_OPENROUTER_API_KEY` from the environment or the local `.env`. Only the synthetic fixture is supplied to the model. Results contain answers, SQL, evidence and timing; they never include credentials. The default output is `audit-output/chat-eval-live.json`.

Useful options:

- `--cases net-completed,join-fanout,rows-15-chart,missing-date,readonly-capability` selects a bounded comparison set.
- `--repeats 3` repeats each selected case (maximum 5).
- `--model provider/model` compares an explicitly selected model with the configured default.
- `--effort none|low|medium|high` selects reasoning effort for a controlled comparison. Omission uses the provider default; supported levels vary by model.
- `--output /absolute/path/results.json` preserves a named run.
- `--server-root /absolute/path/compiled-server` evaluates a compiled baseline. It must contain `server/` and `shared/` built by this repository.

For multi-turn reasoning, run `node --env-file-if-exists=.env scripts/evaluate-chat-conversations.mjs --model provider/model --effort low`. It exercises a corrected metric, a new filter, explanation of an older saved answer, retained definitions after 1,000 filler messages, and a missing-date question. `--wide-schema` adds 60 synthetic archive tables so the real analytical tables require schema-tool retrieval. Inspect the saved answers and query scope; the filler history is a context-retention check, not a load test.

For real engine integration, run `npm run test:databases` with Docker running. Optional arguments select `postgres`, `mysql`, or `mongodb`. The harnesses start uniquely named containers on localhost, seed synthetic data, connect with restricted readers, exercise the production connectors and WebAgentService with scripted model calls, and remove their containers. They never call a model provider. Model correctness and database integration are separate checks. Connection-establishment blackhole timeouts, hosted TLS networks, and production load still need environment-specific validation.

Numeric grading accepts an exact scalar regardless of its SQL alias and supports explicit column projections. A model can still produce correct evidence in a different shape (for example, a list whose length answers a count question); preserve that automatic failure and document a manual review instead of silently relaxing all comparisons. Provider-reported usage is recorded; missing cost is unavailable, not zero. Compare cost per correct answer as well as latency.

Use the same fixture, case list and model when comparing prompts. Inspect failures before attributing them to reasoning: the automatic scorer compares ordered result values. Cases may declare a column projection and row predicate to permit diagnostic columns without accepting an unrelated number; otherwise additional columns or different row order can fail a valid answer. Selected live cases also enforce word ceilings and forbidden statements such as unsupported currency symbols. These checks do not replace narrative review. Preserve the failed output and explain any manual override. Timing includes initialization, query work, model waiting and streaming; a small run is not a production latency benchmark.

Review every live answer for:

1. **Correctness:** claimed numbers match saved evidence; joins, denominator, NULLs and time boundaries are appropriate.
2. **Meaning:** metric definitions and exclusions are stated when they affect the answer; missing fields and ambiguous requests produce useful clarification.
3. **Evidence:** tables and charts use the referenced result, preserve all saved rows, and label truncation and sampled profiles.
4. **Coherence:** answer first, concise supporting explanation, no unsupported causal claim or generic repeated closing question.
5. **Honest capability:** no attempted writes, no invented completion, and useful partial findings after a failure or limit.
6. **Presentation:** rich text and structured reports render correctly; chart labels and units are intelligible; no raw block JSON reaches the transcript.

Complement this suite with API ownership/recovery tests and browser checks for follow-ups, reload during a run, retry/edit, historical sources, long chats, result controls and report exports. SQLite evidence does not establish live PostgreSQL, MySQL or MongoDB behavior; connector-specific tests and real connection checks remain separate.
