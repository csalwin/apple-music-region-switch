# amtransfer — Design (MVP v0.1)

**Status:** Draft, 2026-05-11. Awaiting user review before moving to the implementation plan.
**Supersedes / refines:** `docs/project-goal.md` (the original brief).

---

## Context

The user is relocating from New Zealand to the United States. Apple's region-change procedure requires cancelling the Apple Music subscription before switching region, and that action wipes the iCloud Music Library. There is no first-party tool for migrating library state across an Apple ID region change.

This document specifies an MVP CLI utility, `amtransfer`, that:

1. Exports the source-account library to disk before subscription cancellation
2. Translates each item to its destination-storefront equivalent via stable cross-storefront identifiers (ISRC for songs, UPC for albums)
3. Imports the translated result into the destination account after resubscription

The three phases run as independent subcommands with file-based handoff, because real-world time of days to weeks elapses between them (Apple's 90-day region-change waiting period plus the cancel/resub gap).

The tool is also published to GitHub for reuse by other users in the same situation.

## Goal

A single-repo Bun TypeScript CLI (~600 lines target) with four subcommands (`spike`, `export`, `match`, `import`), runnable from a Docker dev container, that:

- Reliably captures the source-account library to JSON **before** subscription cancellation. This is the high-stakes phase; the saved JSON file is the project's safety net and the only artifact that cannot be regenerated later.
- Translates exported items via ISRC/UPC against the destination storefront's catalog.
- Imports translated items into the destination account.
- Captures unrecoverable items (no destination match, or write failures) into auditable CSV files for manual recovery.

## Non-goals (v0.1)

- **TUI** — Bubble Tea / interactive screens. Deferable to v0.2 with no rework.
- **Concurrency** — worker pools, parallel requests. Sequential is acceptable for ≤30-minute total run time. Deferable to v0.2 as a `--concurrency` flag.
- **Per-batch resumability** — sidecar progress files, `--restart` flag. The whole-phase re-run model plus playlist idempotency covers the only real risk. Deferable to v0.2.
- **Auto token refresh** — user re-pastes when tokens expire.
- **Ratings, "Loved", play counts** — Apple Music API has no write endpoint.
- **Smart playlists as dynamic** — exported as static snapshots at export time.
- **Artist library entries** — auto-populate when songs are added; explicit transfer adds little value.
- **Listening history, Replay data, recommendations** — Apple-side only, not portable.
- **Spotify or other services.**
- **GUI.**
- **Audio file downloads** — the tool manipulates library *references*; the audio remains in Apple's catalog.
- **Unit tests** — acceptance is manual end-to-end against a small test playlist. Pure-function unit tests are a v0.2 addition.

## Stack & runtime

- **Bun 1.x + TypeScript** — single-file scripts, native `fetch` + file I/O, no build step required for development.
- **Docker dev container** with `oven/bun:1` base image — required because the user does not have Bun installed locally.
- **No third-party HTTP client** — Bun's native `fetch` is sufficient.
- **No third-party arg parser** in v0.1 — hand-rolled `Bun.argv` parsing for four subcommands.
- **Distribution**: GitHub repo. README documents the `docker compose run …` invocation. Optional v0.2 polish: `bun build --compile` to a single static binary published on GitHub Releases for zero-install end-user use.

## Authentication

The tool does **not** use a paid Apple Developer Program membership ($99/yr). It uses two tokens harvested from `music.apple.com` via browser DevTools:

| Token | Lifetime | Where to find it |
|-------|----------|------------------|
| `developer_token` | ~6 months | JWT in the `Authorization: Bearer …` header of any authenticated XHR in the Network panel (filter by `amp-api`) |
| `media_user_token` | account-bound | Opaque string in the `Media-User-Token` header of the same XHR |

These are passed to `amtransfer` via environment variables:

- `AM_DEV_TOKEN` → developer token
- `AM_USER_TOKEN` → media user token

If either variable is unset at startup, the tool prompts interactively with **masked input** (no terminal echo). This requires a TTY: `-it` on `docker run`, or `tty: true` + `stdin_open: true` on the dev compose service. Non-interactive runs without env vars fail with a clear error.

The same variable names are used across all phases — the user is responsible for substituting the correct token pair before each phase:

- Before `export`: NZ-account tokens
- Before `match`: either pair works (US catalog endpoints don't strictly require `Media-User-Token`)
- Before `import`: US-account tokens

**Tokens never appear in stdout, stderr, or `debug.log`.** The debug log redacts both header values to `***`.

## Repository layout

```
.
├── amtransfer.ts          # entry: arg parsing + subcommand dispatch
├── src/
│   ├── client.ts          # HTTP client with auth headers, retry, backoff
│   ├── types.ts           # Apple Music API response shapes
│   ├── storage.ts         # JSON + CSV read/write
│   ├── export.ts          # phase 1
│   ├── match.ts           # phase 2
│   ├── import.ts          # phase 3
│   └── spike.ts           # validation pre-flight
├── Dockerfile
├── docker-compose.yml
├── .env.example
├── README.md
├── tsconfig.json
└── package.json           # minimal: type=module, no runtime deps
```

Target: ~600 lines of TypeScript total across all source files.

## Subcommands

### `amtransfer spike`

Validates that the harvested-token + `Origin: https://music.apple.com` auth pattern works for **both read and write operations** against `api.music.apple.com`. This is the foundational risk: if Apple applies stricter validation on writes (CSRF tokens, cookie-bound sessions, additional referer checks) than on reads, the import phase will not function with this auth approach.

Steps:

1. Load `AM_DEV_TOKEN` and `AM_USER_TOKEN` (env or prompt).
2. `GET /v1/me/storefront` — confirm read auth, detect storefront code.
3. `GET /v1/me/library/songs?limit=1` — second read confirmation.
4. `POST /v1/me/library?ids[songs]=<KNOWN_CATALOG_ID>` — simple write auth check. The catalog ID is hardcoded per detected storefront (a free-preview track).
5. `POST /v1/me/library/playlists` with `attributes.name = "__amtransfer_spike__"` and one track in `relationships.tracks` — playlist write (most likely to expose CSRF differences).
6. `GET /v1/me/library/playlists` — verify the spike playlist appears.
7. Print PASS/FAIL with HTTP status for each step.

**Outcome handling:**

- All steps PASS → proceed with confidence on the full design.
- Reads PASS, writes FAIL → the **export phase is still viable** and ships as planned. The import phase narrows to a documented manual recovery path operating on the saved JSON.
- Reads FAIL → the auth pattern is broken entirely; project pauses to investigate.

### `amtransfer export`

Reads the source-account library exhaustively and writes a single JSON snapshot.

**Endpoints** (all under `https://api.music.apple.com`):

- `GET /v1/me/library/playlists?limit=100` — paginate via response `next`
- `GET /v1/me/library/playlists/{id}/tracks?limit=100&include=catalog` — per playlist, paginated
- `GET /v1/me/library/songs?limit=100&include=catalog`
- `GET /v1/me/library/albums?limit=100&include=catalog`

`include=catalog` returns the linked catalog resource alongside each library entry — this is where ISRCs and canonical catalog IDs live. For any library song where the catalog include is missing, fall back to `GET /v1/catalog/{storefront}/songs/{catalog_id}` per item.

The source storefront is detected at startup via `GET /v1/me/storefront`.

**Output:** `amtransfer-data/export.json`

```json
{
  "exported_at": "2026-05-11T10:30:00Z",
  "source_storefront": "nz",
  "playlists": [
    {
      "library_id": "p.xxx",
      "name": "Late nights",
      "description": "",
      "tracks": [
        { "isrc": "USRC11500001", "catalog_id": "...", "name": "...", "artist": "...", "album": "..." }
      ]
    }
  ],
  "songs":  [{ "isrc": "...", "catalog_id": "...", "name": "...", "artist": "...", "album": "..." }],
  "albums": [{ "catalog_id": "...", "name": "...", "artist": "...", "upc": "..." }]
}
```

Library artists are not included — see Non-goals.

**Safety:** the export file is written atomically at the end of the phase (write to `export.json.tmp`, then `rename`). A mid-run crash leaves no partial JSON. Items are buffered in memory until the phase completes; this is acceptable for libraries up to ~100k items.

### `amtransfer match`

Reads `export.json`, resolves every item against the destination storefront (US) by stable cross-storefront identifier.

- **Songs:** batched ISRC lookups, `GET /v1/catalog/us/songs?filter[isrc]=<isrc1>,<isrc2>,…` (up to 25 per call). Any song without an ISRC, or whose ISRC returns no result, is marked unmatched.
- **Albums:** batched UPC lookups, `GET /v1/catalog/us/albums?filter[upc]=…`. Any album without a UPC, or whose UPC returns no result, is marked unmatched.

**No fallback search-by-name in v0.1.** The false-match risk (re-releases, live versions, cover versions with identical names) outweighs the recovery benefit for a tool whose primary audit artifact is a CSV the user reviews manually.

**Outputs:**

- `amtransfer-data/matched.json` — same shape as `export.json`, with each item annotated as either `{ ..., us_catalog_id: "<id>", match_status: "matched" }` or `{ ..., match_status: "unmatched", reason: "<short reason>" }`.
- `amtransfer-data/unmatched.csv` — flat CSV. Columns: `kind, name, artist, album, isrc, upc, reason`. Sortable in any spreadsheet for manual recovery.

### `amtransfer import`

Reads `matched.json`, writes to the destination account.

**Idempotency:** at the start of the phase, `GET /v1/me/library/playlists` once and build a `Set<existing_playlist_name>`. Any to-be-created playlist whose name is already in that set is skipped (and logged). This handles the only material risk of re-running: duplicate playlists. Songs and albums rely on Apple's natural idempotency — `POST /v1/me/library?ids[songs]=…` with an already-present catalog ID is a no-op.

This idempotency model assumes playlist names are unique within the source library. The rare case where the source has two playlists with the same name will result in only one being created on the destination (subsequent runs skip the name). This is acceptable for v0.1; a `--force-create-duplicate` flag is deferable to v0.2 if any user hits the case.

**Endpoints:**

- Songs: `POST /v1/me/library?ids[songs]=<id1>,<id2>,…` — batch up to 25
- Albums: `POST /v1/me/library?ids[albums]=…` — batch up to 25
- Playlists: `POST /v1/me/library/playlists` with body:

  ```json
  {
    "attributes": { "name": "Late nights", "description": "" },
    "relationships": { "tracks": { "data": [{ "id": "1234567890", "type": "songs" }] } }
  }
  ```

Track IDs inside a playlist body **must be catalog song IDs**, not library IDs. After playlist creation, inspect the response: if Apple indicates partial track addition (some tracks dropped), record those drops in `import-failures.csv` with `reason: "dropped during playlist create"`.

**Outputs:**

- `amtransfer-data/import-report.json` — per-kind counts (`requested`, `succeeded`, `failed`) plus the full list of failed items inline.
- `amtransfer-data/import-failures.csv` — flat CSV. Columns: `kind, name, artist, album, us_catalog_id, http_status, error`. Same purpose as `unmatched.csv` but for items that matched but failed at write time.

## HTTP client (`src/client.ts`)

A single `request(method, path, options)` helper used by every phase.

**Headers** on every request:

- `Authorization: Bearer ${AM_DEV_TOKEN}`
- `Media-User-Token: ${AM_USER_TOKEN}`
- `Origin: https://music.apple.com`
- `Accept: application/json`
- `Content-Type: application/json` (on POST)

**Base URL:** `https://api.music.apple.com`

**Per-request timeout:** 30 seconds.

**Concurrency:** sequential. One in-flight `fetch` at a time. A `100ms` sleep between calls keeps the tool politely under typical rate-limit thresholds without explicit throttling logic.

**Retry policy:**

| Response | Action |
|----------|--------|
| 2xx | Return |
| 401 | Fail immediately with `"token expired or invalid"` — do not retry |
| 429 | Sleep for `Retry-After` seconds (default 5 if absent), then exponential backoff with jitter (1s/2s/4s base). Max 3 retries. |
| 5xx | Exponential backoff with jitter (1s/2s/4s base). Max 3 retries. |
| Network error / timeout | Linear backoff (1s). Max 3 retries. |
| Other 4xx | Fail immediately — bad request stays bad |

**Pagination:** library endpoints return `{ data: [...], next: "/v1/me/library/...?offset=N" }`. The `next` URL is path+query only; prefix with the base URL. Iterate until `next` is absent.

**Logging:** every request and response is written to `amtransfer-data/debug.log` as one JSON line per request (method, URL, status, latency, response body truncated to 4 KB). Both header tokens are redacted as `***`.

## Output directory

All artifacts live under `./amtransfer-data/` relative to the working directory. In the Docker dev container, this directory is volume-mounted to the host so files survive `docker compose down`. The directory is created on demand if absent.

## Docker dev environment

`Dockerfile`:

```dockerfile
FROM oven/bun:1
WORKDIR /app
```

`docker-compose.yml`:

```yaml
services:
  dev:
    build: .
    volumes:
      - .:/app
      - ./amtransfer-data:/app/amtransfer-data
    env_file: .env
    tty: true
    stdin_open: true
    working_dir: /app
```

Typical invocation from the host:

```sh
docker compose run --rm dev bun amtransfer.ts export
```

The `tty: true` + `stdin_open: true` settings are **required** for the token-prompt fallback to function when env vars are unset.

`.env.example` documents the two expected variables; users `cp .env.example .env` and fill in values harvested from DevTools.

## Logging behaviour

**Stdout** during a phase:

- Startup banner showing the phase name and a tokens-loaded indicator (no token *values*)
- A single status line rewritten in place via `\r` during long iterations, e.g.:
  ```
  Songs 1247/1893 · Playlists 12/30 · Errors 2
  ```
- Final summary on phase completion, including the path to output files

**`amtransfer-data/debug.log`**:

- One JSON-per-line entry per HTTP request: method, URL, status, latency_ms, response_body (truncated to 4 KB)
- Token headers redacted to `***`
- Easy to `jq`-grep when something goes wrong

## Implementation order

Reflects the export-first priority — export is the only irreversible-deadline phase, everything else can be retried from the saved JSON:

1. **Docker dev container** — `Dockerfile`, `docker-compose.yml`, `.env.example`. Verifiable via `docker compose run --rm dev bun --version`. Must precede everything because Bun is not installed locally.
2. **`spike.ts`** — auth validation. Cheap (~60 lines). Result informs *confidence* in import but does **not** gate export development.
3. **`client.ts`** — productionized HTTP client extracted from the spike: retry/backoff, pagination iterator, structured logging.
4. **`export.ts`** — first must-ship phase. Verify against the real NZ library before subscription cancellation.
5. **README (export section)** — document the export half so it's usable standalone if needed.
6. **`match.ts`**
7. **`import.ts`** — best-effort. If the spike showed write auth blocked, this becomes a documented manual recovery path that operates on the saved JSON.
8. **README (complete)** — adds the migration playbook, token-harvesting instructions for Chrome and Safari, and the known-limitations list.

## Acceptance criteria

- Spike returns PASS for at least read auth (`GET /v1/me/library/songs`) against the real NZ account.
- Export of a ~2000-song / 30-playlist library completes in under 15 minutes on a residential connection. Output JSON is valid and contains every playlist visible in `music.apple.com/library`.
- Mid-run failures produce a clean error and never destroy a previously-completed phase's output (atomic-write via temp-file + rename).
- `unmatched.csv` opens cleanly in Numbers/Excel/Sheets and contains every item that lacks a destination-store match.
- Re-running `import` after a partial completion does not create duplicate playlists (idempotency via existing-playlist-name set).
- Single-file `amtransfer.ts` entrypoint dispatches to all four subcommands; help output (`bun amtransfer.ts` with no args, or `--help`) lists them.
- Tokens never appear in stdout, stderr, or `debug.log`. Verifiable by grep.
- **Confidence check before NZ subscription cancellation**: a full end-to-end run on a small test playlist (5–10 songs) succeeds — exported, matched, imported, and visually verifiable in `music.apple.com/library`. This is the operational gate the user passes before running the real export against the full library.

## Known risks

1. **Write auth may not work with harvested tokens.** Probability: moderate. Impact: high — kills the import phase. **Mitigation:** the spike validates this before any import code is written; if writes fail, the project narrows cleanly to "export tool + documented manual recovery."
2. **Token expiry mid-run.** Developer tokens are valid ~6 months but Apple can invalidate them. **Mitigation:** 401 surfaces as a clean error message; user re-pastes; phase re-runs from scratch (acceptable because phases are short).
3. **ISRC missing on user-uploaded songs.** Some library songs were matched via iCloud Music Library upload, not the catalog, and lack ISRCs. **Mitigation:** they land in `unmatched.csv` for manual review.
4. **US region-locked songs.** Some NZ catalog songs are not available in the US store at all. **Mitigation:** they land in `unmatched.csv` with `reason: "no US match"`.
5. **90-day region-change waiting period.** Apple enforces this in the region-switch UI. Does not affect the tool but does affect the migration timeline; called out in the README.

## README scope (v0.1)

- One-paragraph context: why this exists and when to use it
- Prerequisites: Docker installed; access to your Apple Music account in a browser
- Step-by-step token extraction with text-described UI for **Chrome** and **Safari** (Network tab → `amp-api` filter → click any request → copy `Authorization` and `Media-User-Token` headers)
- Migration playbook in order:
  1. Run `spike` to verify auth (against NZ account)
  2. Run `export` **before** cancelling the source-region subscription
  3. Switch region (90-day waiting period note)
  4. Resubscribe in destination region
  5. Run `match`
  6. Run `import`
- Output file reference: what each file contains, how to use it
- Manual recovery walkthrough using `unmatched.csv` and `import-failures.csv`
- Known limitations (ratings, play counts, listening history — see Non-goals)
