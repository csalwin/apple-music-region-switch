# amtransfer

Migrate an Apple Music library across an Apple ID region change.

When you switch your Apple ID region (for example because you're moving country), Apple requires you to cancel your Apple Music subscription before the region switch. That cancellation **wipes your iCloud Music Library**. This tool exports your library before the switch, translates each item to the destination storefront via cross-storefront identifiers (ISRC for songs, UPC for albums), and re-imports it after you resubscribe.

## Status

v0.1 — MVP. Tested in NZ → US migration. The export phase is the primary deliverable (it captures the irreversible state); match and import are best-effort and can also be performed manually from the saved JSON.

## Prerequisites

- **A browser** signed into music.apple.com on the account you want to read/write.
- Either a prebuilt binary (Option A below) **or** Docker Desktop (Option B). You do not need Bun, Node, or anything else installed locally.

## Installation

Two options. Pick whichever fits.

### Option A: Download a prebuilt binary (recommended)

Grab the right binary for your machine from the [latest release](https://github.com/csalwin/apple-music-region-switch/releases/latest):

| Your machine | File |
|---|---|
| macOS, Apple Silicon (M1–M4) | `amtransfer-darwin-arm64` |
| macOS, Intel | `amtransfer-darwin-x64` |
| Linux, x86_64 | `amtransfer-linux-x64` |
| Linux, ARM64 | `amtransfer-linux-arm64` |
| Windows, x86_64 | `amtransfer-windows-x64.exe` |

**macOS / Linux:**

```sh
# Example for macOS Apple Silicon — substitute your file name as needed
curl -LO https://github.com/csalwin/apple-music-region-switch/releases/latest/download/amtransfer-darwin-arm64
chmod +x amtransfer-darwin-arm64
mv amtransfer-darwin-arm64 amtransfer
./amtransfer --help
```

On macOS, if Gatekeeper blocks the binary with *"cannot be opened because Apple cannot check it for malicious software"*, strip the quarantine attribute once:

```sh
xattr -d com.apple.quarantine ./amtransfer
```

**Windows (PowerShell):**

```powershell
Invoke-WebRequest -OutFile amtransfer.exe `
  https://github.com/csalwin/apple-music-region-switch/releases/latest/download/amtransfer-windows-x64.exe
.\amtransfer.exe --help
```

The binary has zero runtime dependencies — no Bun, Node, or Docker required. Place it somewhere on your `PATH` if you want to call it from any directory.

After installation, every command in the rest of this README that says

```sh
docker compose run --rm dev bun amtransfer.ts <subcommand>
```

can be replaced with the simpler

```sh
./amtransfer <subcommand>
```

You'll still need an `.env` file in the directory you run from (see "Harvesting your tokens" below). Output files appear in `./amtransfer-data/` next to the binary.

### Option B: Run from source (Docker)

If you want to inspect the source, modify the tool, or contribute:

```sh
git clone https://github.com/csalwin/apple-music-region-switch.git
cd apple-music-region-switch
cp .env.example .env
docker compose build
```

The rest of this README's commands are written for Option B (Docker prefix).

## Harvesting your tokens

The tool uses two tokens that the music.apple.com web player sends with every API request: a `developer_token` (a long-lived JWT) and a `media_user_token` (your account session).

**Chrome / Edge / Brave:**

1. Open https://music.apple.com and sign in.
2. Open DevTools (`Cmd+Opt+I` / `Ctrl+Shift+I`) → **Network** tab.
3. In the filter box, type `amp-api`.
4. Click anywhere in the page (browse, play a song) to generate requests.
5. Click any request in the list. In the right panel, open **Headers** → **Request Headers**.
6. Copy the value after `Bearer ` from the `Authorization` header → this is `AM_DEV_TOKEN`.
7. Copy the entire `Media-User-Token` value → this is `AM_USER_TOKEN`.

**Safari:**

1. Enable Develop menu: **Settings → Advanced → Show features for web developers**.
2. Open https://music.apple.com and sign in.
3. Right-click → **Inspect Element** → **Network** tab.
4. Filter by `amp-api`. Click any request → **Headers**.
5. Same fields as above: `Authorization: Bearer <…>` and `Media-User-Token: <…>`.

Paste both values into your `.env` file:

```
AM_DEV_TOKEN=eyJhbGciOi...
AM_USER_TOKEN=AjQ...
```

The developer token is valid for roughly 6 months. The media-user token is valid for the lifetime of your session — if you sign out and back in, harvest a fresh one.

You can also leave `.env` empty and paste the tokens at the interactive prompt when the tool runs. Prompts are masked.

## Validating your tokens (run this first!)

```sh
docker compose run --rm dev bun amtransfer.ts spike
```

This makes a handful of read + write calls against your account, including creating a small test playlist named `__amtransfer_spike__`. Expected output ends with `Overall: PASS`. If any step fails, see the troubleshooting notes at the bottom of this README before continuing.

You can delete the spike playlist manually from music.apple.com afterward.

## Exporting your library

**Run this *before* cancelling your Apple Music subscription.**

```sh
docker compose run --rm dev bun amtransfer.ts export
```

This writes `amtransfer-data/export.json` containing all playlists, library songs, and library albums on the active account, plus their ISRCs and UPCs where available. Keep this file safe — it is the only artifact that cannot be regenerated after the iCloud Music Library is wiped.

The match and import phases are documented further down; you can run them weeks or months later from the same `export.json`.

## Full migration playbook

The phases run independently with file-based handoff because real-world time elapses between them (Apple's 90-day region-change waiting period plus the cancel/resub gap).

### 1. Validate auth (NZ account)

```sh
docker compose run --rm dev bun amtransfer.ts spike
```

Confirm `Overall: PASS`. Manually delete the `__amtransfer_spike__` playlist from music.apple.com.

### 2. Export (NZ account, *before* cancellation)

```sh
docker compose run --rm dev bun amtransfer.ts export
```

`amtransfer-data/export.json` is now your safety net. Back it up somewhere durable (cloud drive, separate machine). After this step it's safe to cancel your NZ subscription.

### 3. Region switch + resubscription

Apple's region switcher enforces a 90-day waiting period since the last region change. Then resubscribe to Apple Music in your new region. Wait until your music.apple.com library is empty (it usually wipes within ~7 days of cancellation).

### 4. Harvest new tokens (US account)

Repeat the token-harvesting steps with your US-account session, replace the values in `.env`.

### 5. Match (US tokens)

```sh
docker compose run --rm dev bun amtransfer.ts match
```

`matched.json` and `unmatched.csv` appear. Skim `unmatched.csv` — it lists songs and albums the US store doesn't carry (region-locked releases, indie distribution gaps, items without ISRCs). For these you have two options:

- Live without them.
- Manually find a US-store equivalent (different release, live version, etc.) and add it to your library via music.apple.com.

### 6. Import (US tokens)

```sh
docker compose run --rm dev bun amtransfer.ts import
```

`import-report.json` summarises what happened; `import-failures.csv` lists items that matched but failed to write (usually transient — re-run import to retry).

### Recovering from `unmatched.csv` and `import-failures.csv`

Both files have the same essential columns (`name`, `artist`, `album`). Open in Numbers/Excel/Sheets. For each row, search for the song on music.apple.com US, click "+ Add" if the right one exists. There is no automated recovery in v0.1 — these files exist precisely so you have a sortable, filterable list of what to deal with manually.

## What this tool does *not* do (v0.1)

- **Ratings / "Loved" / star ratings** — Apple Music API has no write endpoint for these.
- **Play counts and listening history** — Apple-side only, not portable.
- **Replay and recommendations** — Apple-side only.
- **Smart playlists** — exported as static snapshots at export time; rules don't transfer.
- **Library artists** — they auto-populate when songs are added.
- **Songs unavailable in the US store** — landed in `unmatched.csv` rather than silently replaced with a different version.

## Troubleshooting

**Spike fails with HTTP 401:** your tokens are stale or malformed. Re-harvest from a fresh music.apple.com session. Don't include the `Bearer ` prefix when copying — copy only the JWT itself.

**Spike fails on the playlist write step but reads work:** Apple may have tightened write-side validation beyond the headers this tool sets. The `export` and `match` phases will still work. `import` will not; use `unmatched.csv` and the saved `export.json` to do the writes manually via music.apple.com.

**Export reports 0 songs but you have a populated library:** confirm your `AM_USER_TOKEN` is from the correct account — it's account-scoped, not just region-scoped.

**Re-running `import` is creating duplicate playlists:** the idempotency check uses exact name match. If your source library had two playlists with the same name, one of them was created on the first run and the second is being created on the re-run. Rename one in music.apple.com to fix.

## Known limitations

- Sequential request execution: the full flow for a ~2000-song / 30-playlist library takes 10–20 minutes.
- No checkpoint resumability: a crashed phase re-runs from the start. Playlist idempotency prevents duplicates; songs/albums are no-ops if already present.
- No automatic token refresh: tokens expire and must be re-harvested manually.

## Contributing

This is a personal tool published for others in the same situation. Bug reports welcome via GitHub Issues; PRs welcome but please open an issue first to discuss scope.

## License

MIT.
