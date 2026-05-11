# amtransfer

Migrate an Apple Music library across an Apple ID region change.

When you switch your Apple ID region (for example because you're moving country), Apple requires you to cancel your Apple Music subscription before the region switch. That cancellation **wipes your iCloud Music Library**. This tool exports your library before the switch, translates each item to the destination storefront via cross-storefront identifiers (ISRC for songs, UPC for albums), and re-imports it after you resubscribe.

## Status

v0.1 — MVP. Tested in NZ → US migration. The export phase is the primary deliverable (it captures the irreversible state); match and import are best-effort and can also be performed manually from the saved JSON.

## Prerequisites

- **Docker Desktop** (Mac, Windows, or Linux). The project ships only a Docker dev container; you don't need Bun, Node, or anything else installed locally.
- **A browser** signed into music.apple.com on the account you want to read/write.

## Setup

```sh
git clone https://github.com/<you>/amtransfer.git
cd amtransfer
cp .env.example .env
docker compose build
```

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
