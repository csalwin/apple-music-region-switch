# Apple Music NZ → US Library Transfer — Build Brief

## Context
I'm relocating from New Zealand to the United States and need to migrate my Apple Music library across Apple ID region change. Apple's official path requires cancelling the subscription before switching region, which wipes the iCloud Music Library. I want a CLI/TUI tool that uses the Apple Music API directly to:

1. **Export** my library from the NZ account before I cancel
2. **Match** every item against the US catalog (ISRC-first)
3. **Import** everything into the US account after I resubscribe

The three phases run independently with checkpointed state, because there's a real-world gap of days/weeks between them.

## Goal
A single static Go binary with a Bubble Tea TUI that handles all three phases. Resumable, polite to the API, and auditable (every decision written to disk as JSON/CSV).

## Stack
- **Go 1.22+**, no CGO, pure-Go static binary
- **Bubble Tea** (`github.com/charmbracelet/bubbletea`) for the TUI runtime
- **Lip Gloss** (`github.com/charmbracelet/lipgloss`) for styling
- **Bubbles** (`github.com/charmbracelet/bubbles`) for `textinput`, `spinner`, `progress`
- **Cobra** (`github.com/spf13/cobra`) for subcommand routing
- Standard `net/http` — no third-party HTTP clients
- Tests with standard `testing`

## Authentication approach
I do **not** have an Apple Developer Program membership ($99/yr). The tool harvests two tokens from the music.apple.com web player via browser DevTools:

- `developer_token` — JWT in the `Authorization: Bearer …` header of any authenticated XHR. Valid ~6 months.
- `media_user_token` — opaque, in the `Media-User-Token` header. Identifies the logged-in account.

The TUI must include an in-app **"How to get your tokens"** screen with step-by-step instructions for Chrome and Safari (Network tab → filter by `amp-api` → click any request → copy headers). Treat both tokens as secrets — mask in TUI input, never log in plaintext.

I'll supply one token pair for the NZ account (Export) and a separate pair for the US account (Import). Dev token may or may not be the same.

## Architecture

Three subcommands, each independently runnable. All state lives in a working directory (default `./amtransfer-data/`).

### `amtransfer export`
Pulls library from the source account.

Endpoints (all under `https://api.music.apple.com`):
- `GET /v1/me/library/playlists?limit=100` — paginate via `next`
- `GET /v1/me/library/playlists/{id}/tracks?limit=100&include=catalog` — per playlist
- `GET /v1/me/library/songs?limit=100&include=catalog`
- `GET /v1/me/library/albums?limit=100&include=catalog`
- `GET /v1/me/library/artists?limit=100`

`include=catalog` returns the linked catalog resource alongside the library entry, which is where ISRCs and canonical catalog IDs live. For any library song where the catalog include is missing, fall back to `GET /v1/catalog/{storefront}/songs/{catalog-id}` to retrieve the ISRC. Detect source storefront from the first response.

Output: `export.json`
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
  "songs":   [{ "isrc": "...", "catalog_id": "...", "name": "...", "artist": "...", "album": "..." }],
  "albums":  [{ "catalog_id": "...", "name": "...", "artist": "...", "upc": "..." }],
  "artists": [{ "catalog_id": "...", "name": "..." }]
}
```

### `amtransfer match`
Reads `export.json`, resolves every item against the **US** catalog.

- **Songs**: batch ISRC lookups — `GET /v1/catalog/us/songs?filter[isrc]={isrc1},{isrc2},…` (up to 25 per call). ISRC is the only reliable cross-storefront key.
- **Albums**: UPC lookup if available — `GET /v1/catalog/us/albums?filter[upc]=…`. Fallback to `GET /v1/catalog/us/search?term={artist}+{album}&types=albums&limit=1`.
- **Artists**: `GET /v1/catalog/us/search?term={name}&types=artists&limit=1`. Compare canonical names case-insensitively before accepting.

Output:
- `matched.json` — same shape as `export.json` but with each entry annotated with `us_catalog_id` (string) or `match_status: "unmatched"`.
- `unmatched.csv` — flat CSV with columns `kind,name,artist,album,isrc,reason` for manual review.

### `amtransfer import`
Reads `matched.json`, writes to the destination account.

- Songs: `POST /v1/me/library?ids[songs]={id1},{id2},…` — batch up to 25
- Albums: `POST /v1/me/library?ids[albums]=…`
- Artists: `POST /v1/me/library?ids[artists]=…`
- Playlists: `POST /v1/me/library/playlists` with body
  ```json
  {
    "attributes": { "name": "Late nights", "description": "" },
    "relationships": { "tracks": { "data": [{ "id": "1234567890", "type": "songs" }] } }
  }
  ```

Tracks inside a playlist body must be **catalog** song IDs, not library IDs. After playlist creation, if the response indicates partial track addition, log which tracks were dropped.

Output: `import-report.json` with per-kind counts (`requested`, `succeeded`, `failed`) and a list of failed items with error bodies.

### `amtransfer status`
Prints what's been done so far based on which checkpoint files exist and their `*.progress.json` sidecars. Shows next recommended command.

## Cross-cutting concerns

### HTTP client (`internal/api/client.go`)
- Base URL `https://api.music.apple.com`
- Default headers on every request:
  - `Authorization: Bearer {developer_token}`
  - `Media-User-Token: {media_user_token}`
  - `Origin: https://music.apple.com`
  - `Accept: application/json`
- Per-request timeout: 30s
- Concurrency: bounded worker pool, default 4, configurable via `--concurrency` flag
- Retry policy:
  - **401** → bubble up immediately with a clear "token expired/invalid" error. Do not retry.
  - **429** → respect `Retry-After` header (seconds), then exponential backoff with jitter. Max 5 retries.
  - **5xx** → exponential backoff with jitter, max 5 retries.
  - Network errors → 3 retries with backoff.
- All requests/responses logged to `amtransfer-data/debug.log` (truncate bodies to 4KB). Tokens never appear in log output.

### Pagination
Library endpoints return `{ data: [...], next: "/v1/me/library/...?offset=N" }`. Follow `next` until absent. The `next` URL is path+query only — prefix with the base URL.

### Resumability
Each phase writes a `.progress.json` sidecar updated after every successful batch. On re-run, the phase resumes from the last saved offset. Force a fresh run with `--restart`.

### TUI UX
Single binary, Cobra subcommands. Each subcommand opens a Bubble Tea program with these screens:

1. **Welcome** — what this phase does, what tokens are needed, link to in-app help
2. **Token entry** — two `textinput` fields, masked, with paste support; "Show tokens (Y/N)" toggle for verification
3. **Confirm** — short summary of what's about to happen, source/destination storefront detected
4. **Progress** — spinner + progress bar + live counts (e.g. `Songs: 1247 / 1893 · Playlists: 12 / 30 · Errors: 2`)
5. **Summary** — final counts, path to output files, next-command hint

Theme: minimal — single accent color (your call), plenty of whitespace, no emoji clutter. Help footer with key bindings always visible.

### Configuration
Flags (Cobra):
- `--data-dir` (default `./amtransfer-data`)
- `--concurrency` (default 4)
- `--restart` (ignore progress, start fresh)
- `--non-interactive` — accept tokens via env vars `AM_DEV_TOKEN` and `AM_USER_TOKEN`; skip TUI; useful for testing

## Project structure
```
.
├── cmd/amtransfer/main.go
├── internal/
│   ├── api/
│   │   ├── client.go        # HTTP client, retry, backoff
│   │   ├── pagination.go
│   │   └── types.go         # Apple Music API response structs
│   ├── export/export.go
│   ├── match/match.go
│   ├── imp/import.go        # 'import' is reserved
│   ├── store/store.go       # JSON checkpoint read/write
│   └── tui/
│       ├── welcome.go
│       ├── tokens.go
│       ├── progress.go
│       └── summary.go
├── go.mod
├── go.sum
├── README.md
└── Makefile                 # build, test, lint
```

## README must include
- One-line install: `go install github.com/<me>/amtransfer/cmd/amtransfer@latest`
- Step-by-step token extraction with screenshots-as-text for Chrome and Safari
- The migration playbook: when to run export (before cancelling NZ sub), the 90-day region-change waiting period note, when to run match (anytime after export), when to run import (after US account resubscribed)
- How to inspect `unmatched.csv` and what causes unmatches (region-locked releases, ISRC missing on library upload, etc.)
- Known limitations:
  - Ratings ("Loved" / star ratings) are not preserved — Apple Music API has no write endpoint for these
  - Songs unavailable in US storefront will be skipped, not silently replaced with a different version
  - Smart playlists are exported as static playlists at the point-in-time of export
  - Listening history, recommendations, and Replay data do not transfer (Apple-side only)

## Acceptance criteria
- A library of ~2000 songs / 30 playlists completes export → match → import in under 30 minutes on a normal residential connection
- Token expiry mid-run surfaces a clean error and the next run resumes from the last checkpoint
- `--restart` wipes progress for a clean re-run
- All decisions (matched/unmatched) auditable from persisted files
- Single static binary, no runtime dependencies
- Unit tests for: ISRC batching, pagination cursor handling, retry/backoff math, unmatched CSV formatting
- Manual end-to-end test passes on at least one small playlist before merging

## Out of scope
- OAuth / proper MusicKit JS sign-in flow (using DevTools token harvesting is intentional)
- Spotify or any other service
- GUI
- Auto-refresh of expired tokens (user re-pastes)
- Preservation of ratings, play counts, or play history
- Downloading audio files (we only manipulate library references)

## Deliverable
Working repo, single PR, with the structure above, passing tests, and a README that I can hand to a less-technical person and have them follow successfully.
