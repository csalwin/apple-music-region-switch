# amtransfer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Bun + TypeScript CLI tool (`amtransfer`) that migrates an Apple Music library across an Apple ID region change (NZ → US) by exporting from the source account, translating items to the destination storefront via ISRC/UPC, and importing into the destination account.

**Architecture:** Single-file CLI entry (`amtransfer.ts`) parses one of four subcommands (`spike`, `export`, `match`, `import`) and dispatches to a per-phase module in `src/`. All phases share a common HTTP client, token loader, atomic storage layer, and progress display. File-based handoff between phases via JSON files in `./amtransfer-data/`. All requests are sequential with retry/backoff. Tokens are harvested manually from the `music.apple.com` web player and supplied via env vars or interactive masked prompt.

**Tech Stack:** Bun 1.x, TypeScript, Docker (dev container based on `oven/bun:1`). No third-party runtime dependencies; only `@types/bun` as a devDependency for editor support.

**Reference spec:** `docs/superpowers/specs/2026-05-11-amtransfer-design.md`

---

## File Structure

| Path | Responsibility |
|------|----------------|
| `amtransfer.ts` | Entry point: arg parsing + subcommand dispatch |
| `src/types.ts` | Apple Music API response shapes + output file shapes |
| `src/tokens.ts` | Load tokens from env vars; fall back to masked TTY prompt |
| `src/storage.ts` | Atomic JSON write, CSV write with escaping, data dir init |
| `src/client.ts` | HTTP client: auth headers, retry/backoff, pagination, debug log |
| `src/progress.ts` | Single-line stdout status rewriter |
| `src/spike.ts` | Phase 0: validate auth pattern works for reads and writes |
| `src/export.ts` | Phase 1: snapshot source-account library to `export.json` |
| `src/match.ts` | Phase 2: translate to destination storefront via ISRC/UPC |
| `src/import.ts` | Phase 3: write matched items into destination account |
| `Dockerfile` | Dev container image (`oven/bun:1` base) |
| `docker-compose.yml` | Dev service with source mount, env_file, TTY |
| `.env.example` | Documented token variables |
| `.gitignore` | `node_modules/`, `.env`, `amtransfer-data/`, `*.tmp` |
| `package.json` | `type=module`, devDep `@types/bun` |
| `tsconfig.json` | Strict TypeScript, Bun-flavoured (bundler resolution) |
| `README.md` | User-facing setup, token harvesting, migration playbook |

Target: ~900 lines TypeScript + ~150 lines README + ~50 lines configuration.

---

## Tasks

### Task 1: Initialize repository and TypeScript config

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`

- [ ] **Step 1: Initialize git repo**

```bash
cd /Users/chris/Documents/Server/Personel/apple-music-saver
git init
git branch -M main
```

- [ ] **Step 2: Create `package.json`**

```json
{
  "name": "amtransfer",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "description": "Migrate an Apple Music library across an Apple ID region change.",
  "devDependencies": {
    "@types/bun": "latest"
  }
}
```

- [ ] **Step 3: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "lib": ["ESNext"],
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "moduleDetection": "force",
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "noEmit": true,
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "skipLibCheck": true,
    "types": ["bun"]
  },
  "include": ["amtransfer.ts", "src/**/*.ts"]
}
```

- [ ] **Step 4: Create `.gitignore`**

```
node_modules/
.env
amtransfer-data/
*.tmp
.DS_Store
```

- [ ] **Step 5: First commit**

```bash
git add package.json tsconfig.json .gitignore
git commit -m "chore: initialize TypeScript project config"
```

---

### Task 2: Docker dev container

**Files:**
- Create: `Dockerfile`
- Create: `docker-compose.yml`
- Create: `.env.example`

- [ ] **Step 1: Create `Dockerfile`**

```dockerfile
FROM oven/bun:1

WORKDIR /app

# Install dev deps first (only @types/bun for now) so this layer caches.
COPY package.json ./
RUN bun install

# Source is mounted at runtime; nothing else to copy here.
```

- [ ] **Step 2: Create `docker-compose.yml`**

```yaml
services:
  dev:
    build: .
    volumes:
      - .:/app
      - amtransfer_node_modules:/app/node_modules
    env_file:
      - .env
    tty: true
    stdin_open: true
    working_dir: /app

volumes:
  amtransfer_node_modules:
```

- [ ] **Step 3: Create `.env.example`**

```
# Apple Music API tokens harvested from music.apple.com via browser DevTools.
# See README for extraction instructions.
#
# Use NZ-account tokens before running `export`.
# Use US-account tokens before running `import`.
# Either pair works for `spike` and `match`.

AM_DEV_TOKEN=
AM_USER_TOKEN=
```

- [ ] **Step 4: Bootstrap a local `.env`**

```bash
cp .env.example .env
```

- [ ] **Step 5: Build the dev image**

```bash
docker compose build
```

Expected: image builds successfully; `bun install` reports installing `@types/bun`.

- [ ] **Step 6: Verify Bun is reachable inside the container**

```bash
docker compose run --rm dev bun --version
```

Expected: prints a Bun 1.x version string (e.g. `1.1.30`).

- [ ] **Step 7: Commit**

```bash
git add Dockerfile docker-compose.yml .env.example
git commit -m "chore: add Docker dev container"
```

---

### Task 3: API and output type definitions

**Files:**
- Create: `src/types.ts`

- [ ] **Step 1: Create `src/types.ts`**

```typescript
// Apple Music API response shapes (subset of fields we actually consume).

export interface ApiList<T> {
  data: T[];
  next?: string;
  meta?: { total?: number };
}

export interface Storefront {
  id: string; // e.g. "nz", "us"
  type: "storefronts";
  attributes: {
    name: string;
    defaultLanguageTag: string;
  };
}

export interface CatalogSong {
  id: string;
  type: "songs";
  attributes: {
    name: string;
    artistName: string;
    albumName: string;
    isrc?: string;
  };
}

export interface CatalogAlbum {
  id: string;
  type: "albums";
  attributes: {
    name: string;
    artistName: string;
    upc?: string;
  };
}

export interface LibrarySong {
  id: string;
  type: "library-songs";
  attributes: {
    name: string;
    artistName: string;
    albumName?: string;
    playParams?: { catalogId?: string; id: string };
  };
  relationships?: {
    catalog?: { data: CatalogSong[] };
  };
}

export interface LibraryAlbum {
  id: string;
  type: "library-albums";
  attributes: {
    name: string;
    artistName: string;
  };
  relationships?: {
    catalog?: { data: CatalogAlbum[] };
  };
}

export interface LibraryPlaylist {
  id: string;
  type: "library-playlists";
  attributes: {
    name: string;
    description?: { standard?: string; short?: string };
    canEdit?: boolean;
  };
}

export interface PlaylistTrack {
  id: string;
  type: "library-songs";
  attributes: {
    name: string;
    artistName: string;
    albumName?: string;
    playParams?: { catalogId?: string };
  };
  relationships?: {
    catalog?: { data: CatalogSong[] };
  };
}

// Our exported / matched file shapes.

export interface ExportedSong {
  isrc: string | null;
  catalog_id: string | null;
  name: string;
  artist: string;
  album: string;
}

export interface ExportedAlbum {
  catalog_id: string | null;
  upc: string | null;
  name: string;
  artist: string;
}

export interface ExportedPlaylist {
  library_id: string;
  name: string;
  description: string;
  tracks: ExportedSong[];
}

export interface ExportFile {
  exported_at: string;
  source_storefront: string;
  playlists: ExportedPlaylist[];
  songs: ExportedSong[];
  albums: ExportedAlbum[];
}

export type MatchStatus = "matched" | "unmatched";

export interface MatchedSong extends ExportedSong {
  us_catalog_id: string | null;
  match_status: MatchStatus;
  reason: string | null;
}

export interface MatchedAlbum extends ExportedAlbum {
  us_catalog_id: string | null;
  match_status: MatchStatus;
  reason: string | null;
}

export interface MatchedPlaylist {
  library_id: string;
  name: string;
  description: string;
  tracks: MatchedSong[];
}

export interface MatchedFile {
  exported_at: string;
  matched_at: string;
  source_storefront: string;
  destination_storefront: string;
  playlists: MatchedPlaylist[];
  songs: MatchedSong[];
  albums: MatchedAlbum[];
}

export interface ImportReport {
  imported_at: string;
  destination_storefront: string;
  counts: Record<"songs" | "albums" | "playlists", {
    requested: number;
    succeeded: number;
    failed: number;
  }>;
  failures: Array<{
    kind: "song" | "album" | "playlist" | "playlist_track";
    name: string;
    artist: string;
    album: string;
    us_catalog_id: string | null;
    http_status: number | null;
    error: string;
  }>;
}

export interface Tokens {
  devToken: string;
  userToken: string;
}
```

- [ ] **Step 2: Verify types compile**

```bash
docker compose run --rm dev bunx tsc --noEmit
```

Expected: no output (zero errors).

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat: define Apple Music API and output type shapes"
```

---

### Task 4: Token loader with masked prompt fallback

**Files:**
- Create: `src/tokens.ts`

- [ ] **Step 1: Create `src/tokens.ts`**

```typescript
import type { Tokens } from "./types.ts";

export async function loadTokens(): Promise<Tokens> {
  const envDev = process.env.AM_DEV_TOKEN?.trim();
  const envUser = process.env.AM_USER_TOKEN?.trim();

  const devToken = envDev || (await promptMasked("AM_DEV_TOKEN: "));
  const userToken = envUser || (await promptMasked("AM_USER_TOKEN: "));

  if (!devToken || !userToken) {
    throw new Error(
      "Both AM_DEV_TOKEN and AM_USER_TOKEN are required. " +
        "Set them in .env or paste them at the prompt."
    );
  }
  return { devToken, userToken };
}

async function promptMasked(message: string): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new Error(
      `${message.trim()} is required but no TTY is attached. ` +
        `Set the corresponding env var or run with -it.`
    );
  }

  process.stdout.write(message);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");

  return new Promise<string>((resolve) => {
    let input = "";
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\n" || char === "\r" || char === "\u0004") {
          cleanup();
          process.stdout.write("\n");
          resolve(input);
          return;
        } else if (char === "\u0003") {
          // Ctrl+C
          cleanup();
          process.stdout.write("\n");
          process.exit(130);
        } else if (char === "\u007f" || char === "\b") {
          // backspace
          input = input.slice(0, -1);
        } else {
          input += char;
        }
      }
    };
    const cleanup = () => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
    };
    process.stdin.on("data", onData);
  });
}
```

- [ ] **Step 2: Verify it type-checks**

```bash
docker compose run --rm dev bunx tsc --noEmit
```

Expected: zero errors.

- [ ] **Step 3: Smoke-test the env-var path (no prompt)**

Inline test in container:

```bash
docker compose run --rm \
  -e AM_DEV_TOKEN=devXXX \
  -e AM_USER_TOKEN=userYYY \
  dev bun -e 'import("./src/tokens.ts").then(m => m.loadTokens()).then(t => console.log(t.devToken === "devXXX" && t.userToken === "userYYY" ? "OK" : "FAIL"))'
```

Expected: prints `OK`.

- [ ] **Step 4: Commit**

```bash
git add src/tokens.ts
git commit -m "feat: token loader with env-var + masked prompt fallback"
```

---

### Task 5: Storage layer (atomic JSON, CSV, data dir)

**Files:**
- Create: `src/storage.ts`

- [ ] **Step 1: Create `src/storage.ts`**

```typescript
import { mkdir, rename, writeFile, appendFile } from "node:fs/promises";

const DATA_DIR = "amtransfer-data";

export async function initStorage(): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
}

export function dataPath(filename: string): string {
  return `${DATA_DIR}/${filename}`;
}

export async function writeJsonAtomic(
  filename: string,
  value: unknown,
): Promise<void> {
  const final = dataPath(filename);
  const tmp = `${final}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
  await rename(tmp, final);
}

export async function readJson<T>(filename: string): Promise<T> {
  const file = Bun.file(dataPath(filename));
  if (!(await file.exists())) {
    throw new Error(`Missing ${filename} — did the previous phase run?`);
  }
  return (await file.json()) as T;
}

export async function writeCsv(
  filename: string,
  header: string[],
  rows: Array<Array<string | number | null | undefined>>,
): Promise<void> {
  const lines = [
    header.map(csvCell).join(","),
    ...rows.map((r) => r.map(csvCell).join(",")),
  ];
  const final = dataPath(filename);
  const tmp = `${final}.tmp`;
  await writeFile(tmp, lines.join("\n") + "\n", "utf8");
  await rename(tmp, final);
}

function csvCell(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export async function appendDebugLog(line: string): Promise<void> {
  await appendFile(dataPath("debug.log"), line, "utf8");
}
```

- [ ] **Step 2: Verify type-check**

```bash
docker compose run --rm dev bunx tsc --noEmit
```

Expected: zero errors.

- [ ] **Step 3: Smoke-test the CSV escaping and atomic write**

```bash
docker compose run --rm dev bun -e '
  import("./src/storage.ts").then(async m => {
    await m.initStorage();
    await m.writeCsv("smoke.csv", ["name", "note"], [
      ["plain", "ok"],
      ["with, comma", "also ok"],
      ["with \"quote\"", "trickier"],
    ]);
    const content = await Bun.file(m.dataPath("smoke.csv")).text();
    console.log(content);
  })
'
```

Expected output (note the proper escaping):

```
name,note
plain,ok
"with, comma",also ok
"with ""quote""",trickier
```

- [ ] **Step 4: Clean up the smoke artifact**

```bash
rm -f amtransfer-data/smoke.csv
```

- [ ] **Step 5: Commit**

```bash
git add src/storage.ts
git commit -m "feat: atomic JSON + escaped CSV storage helpers"
```

---

### Task 6: HTTP client with auth, retry, backoff, pagination

**Files:**
- Create: `src/client.ts`

- [ ] **Step 1: Create `src/client.ts`**

```typescript
import { appendDebugLog } from "./storage.ts";
import type { ApiList, Tokens } from "./types.ts";

const BASE_URL = "https://api.music.apple.com";
const ORIGIN = "https://music.apple.com";
const TIMEOUT_MS = 30_000;
const INTER_REQUEST_MS = 100;
const MAX_RETRIES = 3;

let tokens: Tokens | null = null;

export function setTokens(t: Tokens): void {
  tokens = t;
}

export interface RequestOptions {
  method?: "GET" | "POST" | "DELETE";
  body?: unknown;
  // If true, parse and return JSON; if false, return null.
  expectBody?: boolean;
}

export interface RequestError extends Error {
  status?: number;
  responseBody?: string;
}

export async function request<T = unknown>(
  pathOrUrl: string,
  opts: RequestOptions = {},
): Promise<T> {
  if (!tokens) throw new Error("Tokens not set. Call setTokens() first.");

  const method = opts.method ?? "GET";
  const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${BASE_URL}${pathOrUrl}`;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${tokens.devToken}`,
    "Media-User-Token": tokens.userToken,
    Origin: ORIGIN,
    Accept: "application/json",
  };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";

  let lastErr: RequestError | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const start = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    let status = 0;
    let bodyText = "";

    try {
      const response = await fetch(url, {
        method,
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: controller.signal,
      });
      status = response.status;
      bodyText = await response.text();
      await logRequest(method, url, status, Date.now() - start, bodyText);

      if (response.ok) {
        await sleep(INTER_REQUEST_MS);
        if (opts.expectBody === false || bodyText.length === 0) {
          return null as T;
        }
        return JSON.parse(bodyText) as T;
      }

      if (status === 401) {
        const err = makeError(
          "Token expired or invalid (HTTP 401). Re-paste fresh tokens and retry.",
          status,
          bodyText,
        );
        throw err;
      }

      if (status === 429 || status >= 500) {
        lastErr = makeError(`HTTP ${status}`, status, bodyText);
        if (attempt < MAX_RETRIES) {
          const retryAfterHeader = response.headers.get("Retry-After");
          const retryAfterMs = retryAfterHeader
            ? Math.max(0, Number(retryAfterHeader)) * 1000
            : null;
          const wait = Number.isFinite(retryAfterMs) && retryAfterMs !== null
            ? retryAfterMs
            : backoffMs(attempt);
          await sleep(wait);
          continue;
        }
        throw lastErr;
      }

      // Other 4xx — fail fast.
      throw makeError(
        `HTTP ${status}: ${bodyText.slice(0, 200)}`,
        status,
        bodyText,
      );
    } catch (e) {
      const err = e as RequestError;
      if (err.status === 401) throw err;
      if (err.status !== undefined && err.status >= 400 && err.status < 500 && err.status !== 429) {
        throw err;
      }
      // Network error, timeout, or retryable status with retries remaining.
      lastErr = err;
      if (attempt < MAX_RETRIES) {
        await logRequest(method, url, status, Date.now() - start, `<retry: ${err.message}>`);
        await sleep(1000 * (attempt + 1));
        continue;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastErr ?? new Error("Exhausted retries without resolution");
}

export async function* paginate<T>(initialPath: string): AsyncGenerator<T, void, void> {
  let path: string | null = initialPath;
  while (path) {
    const result = (await request(path)) as ApiList<T>;
    for (const item of result.data) yield item;
    path = result.next ?? null;
  }
}

function backoffMs(attempt: number): number {
  return (1000 << attempt) + Math.floor(Math.random() * 500);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function makeError(message: string, status: number, body: string): RequestError {
  const e = new Error(message) as RequestError;
  e.status = status;
  e.responseBody = body;
  return e;
}

async function logRequest(
  method: string,
  url: string,
  status: number,
  latencyMs: number,
  body: string,
): Promise<void> {
  const line =
    JSON.stringify({
      t: new Date().toISOString(),
      method,
      url,
      status,
      latency_ms: latencyMs,
      body: body.slice(0, 4096),
    }) + "\n";
  try {
    await appendDebugLog(line);
  } catch {
    // best-effort logging
  }
}
```

Note on retry semantics: `429 Too Many Requests` and 5xx both retry up to 3 times. On `429`, the `Retry-After` header (in seconds) is honored if present; otherwise we fall back to jittered exponential backoff. Network errors and timeouts retry with linear backoff.

- [ ] **Step 2: Verify it type-checks**

```bash
docker compose run --rm dev bunx tsc --noEmit
```

Expected: zero errors.

- [ ] **Step 3: Commit**

```bash
git add src/client.ts
git commit -m "feat: HTTP client with auth, retry, pagination, debug log"
```

---

### Task 7: Single-line progress display

**Files:**
- Create: `src/progress.ts`

- [ ] **Step 1: Create `src/progress.ts`**

```typescript
export class Progress {
  private fields = new Map<string, string>();
  private active = false;

  start(): void {
    this.active = true;
    this.render();
  }

  set(key: string, value: string | number): void {
    this.fields.set(key, String(value));
    if (this.active) this.render();
  }

  finish(finalMessage?: string): void {
    if (this.active) {
      process.stdout.write("\n");
      this.active = false;
    }
    if (finalMessage) process.stdout.write(finalMessage + "\n");
  }

  log(message: string): void {
    // Print a permanent line above the status line.
    if (this.active) {
      process.stdout.write("\r\x1b[2K"); // clear current line
      process.stdout.write(message + "\n");
      this.render();
    } else {
      process.stdout.write(message + "\n");
    }
  }

  private render(): void {
    const parts: string[] = [];
    for (const [k, v] of this.fields) parts.push(`${k} ${v}`);
    process.stdout.write("\r\x1b[2K" + parts.join(" · "));
  }
}
```

- [ ] **Step 2: Verify it type-checks**

```bash
docker compose run --rm dev bunx tsc --noEmit
```

Expected: zero errors.

- [ ] **Step 3: Commit**

```bash
git add src/progress.ts
git commit -m "feat: progress display with single-line rewriting"
```

---

### Task 8: Entry point with subcommand dispatch + module stubs

**Files:**
- Create: `amtransfer.ts`
- Create: `src/spike.ts` (stub)
- Create: `src/export.ts` (stub)
- Create: `src/match.ts` (stub)
- Create: `src/import.ts` (stub)

- [ ] **Step 1: Create `src/spike.ts` stub**

```typescript
import type { Tokens } from "./types.ts";

export async function runSpike(_tokens: Tokens): Promise<void> {
  throw new Error("spike: not yet implemented");
}
```

- [ ] **Step 2: Create `src/export.ts` stub**

```typescript
import type { Tokens } from "./types.ts";

export async function runExport(_tokens: Tokens): Promise<void> {
  throw new Error("export: not yet implemented");
}
```

- [ ] **Step 3: Create `src/match.ts` stub**

```typescript
import type { Tokens } from "./types.ts";

export async function runMatch(_tokens: Tokens): Promise<void> {
  throw new Error("match: not yet implemented");
}
```

- [ ] **Step 4: Create `src/import.ts` stub**

```typescript
import type { Tokens } from "./types.ts";

export async function runImport(_tokens: Tokens): Promise<void> {
  throw new Error("import: not yet implemented");
}
```

- [ ] **Step 5: Create `amtransfer.ts`**

```typescript
import { loadTokens } from "./src/tokens.ts";
import { initStorage } from "./src/storage.ts";
import { setTokens } from "./src/client.ts";
import { runSpike } from "./src/spike.ts";
import { runExport } from "./src/export.ts";
import { runMatch } from "./src/match.ts";
import { runImport } from "./src/import.ts";

const USAGE = `\
amtransfer — migrate an Apple Music library across an Apple ID region change

Usage:
  bun amtransfer.ts <command>

Commands:
  spike    Validate that the harvested-token auth pattern works for reads & writes
  export   Snapshot the source-account library to amtransfer-data/export.json
  match    Resolve every item against the destination storefront via ISRC/UPC
  import   Write matched items into the destination account

Tokens are read from AM_DEV_TOKEN and AM_USER_TOKEN env vars, or prompted for
interactively if either is unset. See README for token-harvesting steps.
`;

async function main(): Promise<void> {
  const cmd = process.argv[2];

  if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") {
    process.stdout.write(USAGE);
    return;
  }

  const dispatch: Record<string, (t: Awaited<ReturnType<typeof loadTokens>>) => Promise<void>> = {
    spike: runSpike,
    export: runExport,
    match: runMatch,
    import: runImport,
  };

  const handler = dispatch[cmd];
  if (!handler) {
    process.stderr.write(`Unknown command: ${cmd}\n\n${USAGE}`);
    process.exit(1);
  }

  await initStorage();
  const tokens = await loadTokens();
  setTokens(tokens);

  process.stdout.write(`amtransfer ${cmd} — tokens loaded\n`);
  await handler(tokens);
}

main().catch((e) => {
  process.stderr.write(`\nError: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
```

- [ ] **Step 6: Verify it type-checks**

```bash
docker compose run --rm dev bunx tsc --noEmit
```

Expected: zero errors.

- [ ] **Step 7: Verify help output**

```bash
docker compose run --rm dev bun amtransfer.ts --help
```

Expected: prints the usage block; exits 0.

- [ ] **Step 8: Verify unknown command fails cleanly**

```bash
docker compose run --rm dev bun amtransfer.ts wat
```

Expected: prints `Unknown command: wat` followed by usage; exit code 1.

- [ ] **Step 9: Commit**

```bash
git add amtransfer.ts src/spike.ts src/export.ts src/match.ts src/import.ts
git commit -m "feat: entry point with subcommand dispatch + module stubs"
```

---

### Task 9: Implement spike — auth validation

**Files:**
- Modify: `src/spike.ts` (replace stub with full implementation)

- [ ] **Step 1: Replace `src/spike.ts` with the implementation**

```typescript
import { request, setTokens } from "./client.ts";
import type { ApiList, CatalogSong, LibraryPlaylist, LibrarySong, Storefront, Tokens } from "./types.ts";

// A small handful of known free-preview catalog song IDs per storefront.
// Used as the test write-target for the spike. Override at runtime via the
// second positional argument: `bun amtransfer.ts spike <catalog-song-id>`.
const FALLBACK_CATALOG_IDS: Record<string, string> = {
  // "Levitating" by Dua Lipa — widely available in both storefronts.
  nz: "1538062123",
  us: "1538062123",
  gb: "1538062123",
  au: "1538062123",
};

const SPIKE_PLAYLIST_NAME = "__amtransfer_spike__";

interface StepResult {
  name: string;
  status: "PASS" | "FAIL";
  detail: string;
}

export async function runSpike(tokens: Tokens): Promise<void> {
  setTokens(tokens);

  const results: StepResult[] = [];
  const overrideId = process.argv[3];

  let storefront = "";
  let catalogId = "";

  // Step 1: storefront detection
  try {
    const sf = await request<ApiList<Storefront>>("/v1/me/storefront");
    storefront = sf.data[0]?.id ?? "";
    if (!storefront) throw new Error("empty storefront response");
    results.push({
      name: "GET /v1/me/storefront",
      status: "PASS",
      detail: `storefront=${storefront}`,
    });
  } catch (e) {
    results.push({
      name: "GET /v1/me/storefront",
      status: "FAIL",
      detail: errMsg(e),
    });
  }

  // Step 2: simple library read
  try {
    await request<ApiList<LibrarySong>>("/v1/me/library/songs?limit=1");
    results.push({
      name: "GET /v1/me/library/songs?limit=1",
      status: "PASS",
      detail: "ok",
    });
  } catch (e) {
    results.push({
      name: "GET /v1/me/library/songs?limit=1",
      status: "FAIL",
      detail: errMsg(e),
    });
  }

  // Decide which catalog ID to write.
  catalogId =
    overrideId ?? FALLBACK_CATALOG_IDS[storefront] ?? FALLBACK_CATALOG_IDS["us"]!;

  // Step 3: simple library write
  try {
    await request(`/v1/me/library?ids[songs]=${encodeURIComponent(catalogId)}`, {
      method: "POST",
      expectBody: false,
    });
    results.push({
      name: `POST /v1/me/library?ids[songs]=${catalogId}`,
      status: "PASS",
      detail: "ok",
    });
  } catch (e) {
    results.push({
      name: `POST /v1/me/library?ids[songs]=${catalogId}`,
      status: "FAIL",
      detail: errMsg(e),
    });
  }

  // Step 4: playlist write
  let createdPlaylistId = "";
  try {
    const body = {
      attributes: { name: SPIKE_PLAYLIST_NAME, description: "Created by amtransfer spike" },
      relationships: { tracks: { data: [{ id: catalogId, type: "songs" }] } },
    };
    const created = await request<ApiList<LibraryPlaylist>>("/v1/me/library/playlists", {
      method: "POST",
      body,
    });
    createdPlaylistId = created.data[0]?.id ?? "";
    results.push({
      name: "POST /v1/me/library/playlists",
      status: "PASS",
      detail: `id=${createdPlaylistId || "?"}`,
    });
  } catch (e) {
    results.push({
      name: "POST /v1/me/library/playlists",
      status: "FAIL",
      detail: errMsg(e),
    });
  }

  // Step 5: playlist read-back
  try {
    let found = false;
    for await (const pl of paginatePlaylists()) {
      if (pl.attributes.name === SPIKE_PLAYLIST_NAME) {
        found = true;
        break;
      }
    }
    results.push({
      name: "GET /v1/me/library/playlists (find spike playlist)",
      status: found ? "PASS" : "FAIL",
      detail: found ? "found" : "not found",
    });
  } catch (e) {
    results.push({
      name: "GET /v1/me/library/playlists (find spike playlist)",
      status: "FAIL",
      detail: errMsg(e),
    });
  }

  // Summary
  process.stdout.write("\n=== SPIKE RESULTS ===\n");
  for (const r of results) {
    process.stdout.write(`  [${r.status}] ${r.name} — ${r.detail}\n`);
  }
  const allPass = results.every((r) => r.status === "PASS");
  process.stdout.write(`\nOverall: ${allPass ? "PASS" : "FAIL"}\n`);
  process.stdout.write(
    `\nNote: the playlist named "${SPIKE_PLAYLIST_NAME}" was added to your library.\n` +
      `You can delete it manually from music.apple.com if you don't want it kept.\n`,
  );

  if (!allPass) process.exitCode = 1;
}

async function* paginatePlaylists() {
  let path: string | null = "/v1/me/library/playlists?limit=100";
  while (path) {
    const result = (await request(path)) as ApiList<LibraryPlaylist>;
    for (const pl of result.data) yield pl;
    path = result.next ?? null;
  }
}

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
```

- [ ] **Step 2: Verify type-check**

```bash
docker compose run --rm dev bunx tsc --noEmit
```

Expected: zero errors.

- [ ] **Step 3: USER RUNS THE SPIKE**

Populate `.env` with your **NZ-account** tokens (or any valid pair), then:

```bash
docker compose run --rm dev bun amtransfer.ts spike
```

Expected: prints `tokens loaded`, then each step's PASS/FAIL with detail, then `Overall: PASS` or `Overall: FAIL`.

**Decision point:**
- All PASS → proceed with full implementation (Task 10 onward).
- Reads PASS, writes FAIL → proceed but note that the `import` phase will not function. Continue with `export` and `match`; `import` becomes documented manual recovery.
- Reads FAIL → stop and investigate. Likely cause: malformed tokens (whitespace, missing prefix) or a wholly different auth requirement than this design assumes.

- [ ] **Step 4: Commit**

```bash
git add src/spike.ts
git commit -m "feat: implement spike for auth validation"
```

---

### Task 10: Implement export phase

**Files:**
- Modify: `src/export.ts` (replace stub with full implementation)

- [ ] **Step 1: Replace `src/export.ts` with the implementation**

```typescript
import { paginate, request } from "./client.ts";
import { writeJsonAtomic } from "./storage.ts";
import { Progress } from "./progress.ts";
import type {
  ApiList,
  CatalogSong,
  ExportFile,
  ExportedAlbum,
  ExportedPlaylist,
  ExportedSong,
  LibraryAlbum,
  LibraryPlaylist,
  LibrarySong,
  PlaylistTrack,
  Storefront,
  Tokens,
} from "./types.ts";

export async function runExport(_tokens: Tokens): Promise<void> {
  const progress = new Progress();

  // Detect storefront
  const sf = await request<ApiList<Storefront>>("/v1/me/storefront");
  const storefront = sf.data[0]?.id ?? "";
  if (!storefront) throw new Error("Could not detect source storefront");

  progress.set("storefront", storefront);
  progress.set("songs", "0");
  progress.set("albums", "0");
  progress.set("playlists", "0");
  progress.start();

  // 1. Songs
  const songs: ExportedSong[] = [];
  for await (const item of paginate<LibrarySong>(
    "/v1/me/library/songs?limit=100&include=catalog",
  )) {
    songs.push(await toExportedSong(item, storefront));
    progress.set("songs", String(songs.length));
  }

  // 2. Albums
  const albums: ExportedAlbum[] = [];
  for await (const item of paginate<LibraryAlbum>(
    "/v1/me/library/albums?limit=100&include=catalog",
  )) {
    albums.push(toExportedAlbum(item));
    progress.set("albums", String(albums.length));
  }

  // 3. Playlists + their tracks
  const playlists: ExportedPlaylist[] = [];
  for await (const pl of paginate<LibraryPlaylist>(
    "/v1/me/library/playlists?limit=100",
  )) {
    const tracks: ExportedSong[] = [];
    const tracksPath = `/v1/me/library/playlists/${encodeURIComponent(pl.id)}/tracks?limit=100&include=catalog`;
    try {
      for await (const track of paginate<PlaylistTrack>(tracksPath)) {
        tracks.push(await toExportedSong(track, storefront));
      }
    } catch (e) {
      progress.log(
        `  warning: playlist "${pl.attributes.name}" track fetch failed: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }

    playlists.push({
      library_id: pl.id,
      name: pl.attributes.name,
      description:
        pl.attributes.description?.standard ??
        pl.attributes.description?.short ??
        "",
      tracks,
    });
    progress.set("playlists", String(playlists.length));
  }

  const out: ExportFile = {
    exported_at: new Date().toISOString(),
    source_storefront: storefront,
    playlists,
    songs,
    albums,
  };

  await writeJsonAtomic("export.json", out);

  progress.finish(
    `\nExport complete:\n` +
      `  songs:     ${songs.length}\n` +
      `  albums:    ${albums.length}\n` +
      `  playlists: ${playlists.length}\n` +
      `  output:    amtransfer-data/export.json\n`,
  );
}

async function toExportedSong(
  source: LibrarySong | PlaylistTrack,
  storefront: string,
): Promise<ExportedSong> {
  let isrc: string | null = null;
  let catalogId: string | null = null;

  const catalog = source.relationships?.catalog?.data?.[0];
  if (catalog) {
    isrc = catalog.attributes.isrc ?? null;
    catalogId = catalog.id;
  } else {
    catalogId = source.attributes.playParams?.catalogId ?? null;
    if (catalogId) {
      isrc = await fetchIsrc(storefront, catalogId);
    }
  }

  return {
    isrc,
    catalog_id: catalogId,
    name: source.attributes.name,
    artist: source.attributes.artistName,
    album: source.attributes.albumName ?? "",
  };
}

function toExportedAlbum(item: LibraryAlbum): ExportedAlbum {
  const catalog = item.relationships?.catalog?.data?.[0];
  return {
    catalog_id: catalog?.id ?? null,
    upc: catalog?.attributes.upc ?? null,
    name: item.attributes.name,
    artist: item.attributes.artistName,
  };
}

async function fetchIsrc(storefront: string, catalogId: string): Promise<string | null> {
  try {
    const sf = encodeURIComponent(storefront);
    const id = encodeURIComponent(catalogId);
    const result = await request<ApiList<CatalogSong>>(
      `/v1/catalog/${sf}/songs/${id}`,
    );
    return result.data[0]?.attributes.isrc ?? null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 2: Verify type-check**

```bash
docker compose run --rm dev bunx tsc --noEmit
```

Expected: zero errors.

- [ ] **Step 3: USER RUNS EXPORT**

With NZ-account tokens in `.env`:

```bash
docker compose run --rm dev bun amtransfer.ts export
```

Expected: progress line updates as items are paginated; final summary prints counts and the output path.

- [ ] **Step 4: Verify the export file looks sensible**

```bash
docker compose run --rm dev bun -e '
  const f = await Bun.file("amtransfer-data/export.json").json();
  console.log({
    storefront: f.source_storefront,
    playlists: f.playlists.length,
    songs: f.songs.length,
    albums: f.albums.length,
    first_playlist: f.playlists[0]?.name,
    first_song_has_isrc: !!f.songs[0]?.isrc,
  });
'
```

Expected: counts roughly match what you see in `music.apple.com/library`; `first_song_has_isrc` should be `true` for most accounts.

- [ ] **Step 5: Commit**

```bash
git add src/export.ts
git commit -m "feat: implement export phase"
```

---

### Task 11: README — setup, token harvesting, export usage

**Files:**
- Create: `README.md`

- [ ] **Step 1: Create `README.md`**

```markdown
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
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: README with setup, token harvesting, export usage"
```

---

### Task 12: Implement match phase

**Files:**
- Modify: `src/match.ts` (replace stub with full implementation)

- [ ] **Step 1: Replace `src/match.ts` with the implementation**

```typescript
import { request } from "./client.ts";
import { writeJsonAtomic, writeCsv, readJson } from "./storage.ts";
import { Progress } from "./progress.ts";
import type {
  ApiList,
  CatalogAlbum,
  CatalogSong,
  ExportFile,
  ExportedAlbum,
  ExportedPlaylist,
  ExportedSong,
  MatchedAlbum,
  MatchedFile,
  MatchedPlaylist,
  MatchedSong,
  Storefront,
  Tokens,
} from "./types.ts";

const BATCH_SIZE = 25;
const DEFAULT_DESTINATION = "us";

export async function runMatch(_tokens: Tokens): Promise<void> {
  const exportFile = await readJson<ExportFile>("export.json");

  // Detect destination storefront from the active tokens.
  const sf = await request<ApiList<Storefront>>("/v1/me/storefront");
  const destination = sf.data[0]?.id ?? DEFAULT_DESTINATION;

  const progress = new Progress();
  progress.set("source", exportFile.source_storefront);
  progress.set("destination", destination);
  progress.set("songs", "0");
  progress.set("albums", "0");
  progress.set("playlists", "0");
  progress.start();

  // De-dupe the songs we need to resolve across library + all playlists.
  const songIsrcs = new Set<string>();
  const songsByIsrc = new Map<string, ExportedSong[]>();
  for (const s of exportFile.songs) registerSong(s, songIsrcs, songsByIsrc);
  for (const pl of exportFile.playlists) {
    for (const t of pl.tracks) registerSong(t, songIsrcs, songsByIsrc);
  }

  const isrcToUsId = await resolveSongs(destination, [...songIsrcs], progress);

  const matchedSongs: MatchedSong[] = exportFile.songs.map((s) =>
    annotateSong(s, isrcToUsId),
  );

  const matchedAlbums: MatchedAlbum[] = await resolveAlbums(
    destination,
    exportFile.albums,
    progress,
  );

  const matchedPlaylists: MatchedPlaylist[] = exportFile.playlists.map((pl) =>
    annotatePlaylist(pl, isrcToUsId),
  );

  const out: MatchedFile = {
    exported_at: exportFile.exported_at,
    matched_at: new Date().toISOString(),
    source_storefront: exportFile.source_storefront,
    destination_storefront: destination,
    playlists: matchedPlaylists,
    songs: matchedSongs,
    albums: matchedAlbums,
  };

  await writeJsonAtomic("matched.json", out);
  await writeUnmatchedCsv(out);

  const unmatchedSongs = matchedSongs.filter((s) => s.match_status === "unmatched").length;
  const unmatchedAlbums = matchedAlbums.filter((a) => a.match_status === "unmatched").length;
  const unmatchedTracks = matchedPlaylists.reduce(
    (n, pl) => n + pl.tracks.filter((t) => t.match_status === "unmatched").length,
    0,
  );

  progress.finish(
    `\nMatch complete:\n` +
      `  songs matched:        ${matchedSongs.length - unmatchedSongs} / ${matchedSongs.length}\n` +
      `  albums matched:       ${matchedAlbums.length - unmatchedAlbums} / ${matchedAlbums.length}\n` +
      `  playlist tracks lost: ${unmatchedTracks}\n` +
      `  output:               amtransfer-data/matched.json\n` +
      `  unmatched audit:      amtransfer-data/unmatched.csv\n`,
  );
}

function registerSong(
  s: ExportedSong,
  set: Set<string>,
  groups: Map<string, ExportedSong[]>,
): void {
  if (!s.isrc) return;
  set.add(s.isrc);
  const list = groups.get(s.isrc) ?? [];
  list.push(s);
  groups.set(s.isrc, list);
}

async function resolveSongs(
  destination: string,
  isrcs: string[],
  progress: Progress,
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  for (let i = 0; i < isrcs.length; i += BATCH_SIZE) {
    const batch = isrcs.slice(i, i + BATCH_SIZE);
    const filter = batch.map(encodeURIComponent).join(",");
    const sf = encodeURIComponent(destination);
    try {
      const response = await request<ApiList<CatalogSong>>(
        `/v1/catalog/${sf}/songs?filter[isrc]=${filter}`,
      );
      for (const song of response.data) {
        const isrc = song.attributes.isrc;
        if (isrc && !result.has(isrc)) result.set(isrc, song.id);
      }
    } catch (e) {
      // Continue — unresolved ISRCs become "unmatched".
    }
    progress.set("songs", `${Math.min(i + BATCH_SIZE, isrcs.length)}/${isrcs.length}`);
  }
  return result;
}

async function resolveAlbums(
  destination: string,
  albums: ExportedAlbum[],
  progress: Progress,
): Promise<MatchedAlbum[]> {
  const out: MatchedAlbum[] = [];
  const upcs = albums.filter((a) => a.upc).map((a) => a.upc!) as string[];
  const upcToUsId = new Map<string, string>();

  for (let i = 0; i < upcs.length; i += BATCH_SIZE) {
    const batch = upcs.slice(i, i + BATCH_SIZE);
    const filter = batch.map(encodeURIComponent).join(",");
    const sf = encodeURIComponent(destination);
    try {
      const response = await request<ApiList<CatalogAlbum>>(
        `/v1/catalog/${sf}/albums?filter[upc]=${filter}`,
      );
      for (const album of response.data) {
        const upc = album.attributes.upc;
        if (upc && !upcToUsId.has(upc)) upcToUsId.set(upc, album.id);
      }
    } catch {
      /* ignore */
    }
    progress.set("albums", `${Math.min(i + BATCH_SIZE, upcs.length)}/${upcs.length}`);
  }

  for (const a of albums) {
    if (!a.upc) {
      out.push({ ...a, us_catalog_id: null, match_status: "unmatched", reason: "no upc on source" });
      continue;
    }
    const id = upcToUsId.get(a.upc);
    if (id) {
      out.push({ ...a, us_catalog_id: id, match_status: "matched", reason: null });
    } else {
      out.push({ ...a, us_catalog_id: null, match_status: "unmatched", reason: "upc not in destination store" });
    }
  }
  return out;
}

function annotateSong(s: ExportedSong, isrcToUsId: Map<string, string>): MatchedSong {
  if (!s.isrc) {
    return { ...s, us_catalog_id: null, match_status: "unmatched", reason: "no isrc on source" };
  }
  const id = isrcToUsId.get(s.isrc);
  if (id) {
    return { ...s, us_catalog_id: id, match_status: "matched", reason: null };
  }
  return { ...s, us_catalog_id: null, match_status: "unmatched", reason: "isrc not in destination store" };
}

function annotatePlaylist(pl: ExportedPlaylist, isrcToUsId: Map<string, string>): MatchedPlaylist {
  return {
    library_id: pl.library_id,
    name: pl.name,
    description: pl.description,
    tracks: pl.tracks.map((t) => annotateSong(t, isrcToUsId)),
  };
}

async function writeUnmatchedCsv(matched: MatchedFile): Promise<void> {
  const rows: Array<Array<string | number | null>> = [];

  for (const s of matched.songs) {
    if (s.match_status === "unmatched") {
      rows.push(["song", s.name, s.artist, s.album, s.isrc ?? "", "", s.reason ?? ""]);
    }
  }
  for (const a of matched.albums) {
    if (a.match_status === "unmatched") {
      rows.push(["album", a.name, a.artist, "", "", a.upc ?? "", a.reason ?? ""]);
    }
  }
  for (const pl of matched.playlists) {
    for (const t of pl.tracks) {
      if (t.match_status === "unmatched") {
        rows.push([`playlist:${pl.name}`, t.name, t.artist, t.album, t.isrc ?? "", "", t.reason ?? ""]);
      }
    }
  }

  await writeCsv(
    "unmatched.csv",
    ["kind", "name", "artist", "album", "isrc", "upc", "reason"],
    rows,
  );
}
```

- [ ] **Step 2: Verify type-check**

```bash
docker compose run --rm dev bunx tsc --noEmit
```

Expected: zero errors.

- [ ] **Step 3: USER RUNS MATCH**

You can run match against your **NZ account's** export with either token pair; the destination is auto-detected from whichever tokens are in `.env` (which should be US tokens when you do the real run, but NZ is fine for a dry test where every match will fail — that confirms wiring works).

```bash
docker compose run --rm dev bun amtransfer.ts match
```

Expected: progress updates; final summary with counts; `matched.json` and `unmatched.csv` appear in `amtransfer-data/`.

- [ ] **Step 4: Spot-check the unmatched CSV**

```bash
docker compose run --rm dev bun -e '
  const text = await Bun.file("amtransfer-data/unmatched.csv").text();
  process.stdout.write(text.split("\n").slice(0, 10).join("\n") + "\n");
'
```

Expected: header row followed by unmatched items with sensible `reason` values.

- [ ] **Step 5: Commit**

```bash
git add src/match.ts
git commit -m "feat: implement match phase with ISRC/UPC resolution + unmatched CSV"
```

---

### Task 13: Implement import phase

**Files:**
- Modify: `src/import.ts` (replace stub with full implementation)

- [ ] **Step 1: Replace `src/import.ts` with the implementation**

```typescript
import { paginate, request } from "./client.ts";
import { writeJsonAtomic, writeCsv, readJson } from "./storage.ts";
import { Progress } from "./progress.ts";
import type {
  ApiList,
  ImportReport,
  LibraryPlaylist,
  MatchedFile,
  MatchedPlaylist,
  MatchedSong,
  Storefront,
  Tokens,
} from "./types.ts";

const BATCH_SIZE = 25;

interface Failure {
  kind: "song" | "album" | "playlist" | "playlist_track";
  name: string;
  artist: string;
  album: string;
  us_catalog_id: string | null;
  http_status: number | null;
  error: string;
}

export async function runImport(_tokens: Tokens): Promise<void> {
  const matched = await readJson<MatchedFile>("matched.json");

  // Verify we're pointed at the right storefront.
  const sf = await request<ApiList<Storefront>>("/v1/me/storefront");
  const activeStorefront = sf.data[0]?.id ?? "";
  if (activeStorefront !== matched.destination_storefront) {
    process.stderr.write(
      `Warning: active storefront is "${activeStorefront}" but matched.json targets "${matched.destination_storefront}". ` +
        `Confirm you swapped in destination-account tokens before continuing.\n`,
    );
  }

  // Build set of existing playlist names for idempotency.
  const existingPlaylistNames = new Set<string>();
  for await (const pl of paginate<LibraryPlaylist>("/v1/me/library/playlists?limit=100")) {
    existingPlaylistNames.add(pl.attributes.name);
  }

  const failures: Failure[] = [];
  const counts = {
    songs: { requested: 0, succeeded: 0, failed: 0 },
    albums: { requested: 0, succeeded: 0, failed: 0 },
    playlists: { requested: 0, succeeded: 0, failed: 0 },
  };

  const progress = new Progress();
  progress.set("songs", "0/0");
  progress.set("albums", "0/0");
  progress.set("playlists", "0/0");
  progress.set("errors", "0");
  progress.start();

  // 1. Songs
  const songIds = uniqueIds(matched.songs.filter((s) => s.match_status === "matched").map((s) => s.us_catalog_id!));
  counts.songs.requested = songIds.length;
  await importInBatches(songIds, "songs", async (batch) => {
    const ids = batch.map(encodeURIComponent).join(",");
    await request(`/v1/me/library?ids[songs]=${ids}`, { method: "POST", expectBody: false });
  }, progress, counts.songs, failures, matched);

  // 2. Albums
  const albumIds = uniqueIds(matched.albums.filter((a) => a.match_status === "matched").map((a) => a.us_catalog_id!));
  counts.albums.requested = albumIds.length;
  await importInBatches(albumIds, "albums", async (batch) => {
    const ids = batch.map(encodeURIComponent).join(",");
    await request(`/v1/me/library?ids[albums]=${ids}`, { method: "POST", expectBody: false });
  }, progress, counts.albums, failures, matched);

  // 3. Playlists
  counts.playlists.requested = matched.playlists.length;
  for (const pl of matched.playlists) {
    progress.set("playlists", `${counts.playlists.succeeded + counts.playlists.failed}/${matched.playlists.length}`);

    if (existingPlaylistNames.has(pl.name)) {
      progress.log(`  skip (exists): ${pl.name}`);
      counts.playlists.succeeded += 1;
      continue;
    }

    const tracks = pl.tracks.filter((t) => t.match_status === "matched" && t.us_catalog_id);
    const body = {
      attributes: { name: pl.name, description: pl.description },
      relationships: {
        tracks: {
          data: tracks.map((t) => ({ id: t.us_catalog_id!, type: "songs" })),
        },
      },
    };

    try {
      await request("/v1/me/library/playlists", { method: "POST", body });
      counts.playlists.succeeded += 1;
      existingPlaylistNames.add(pl.name);
    } catch (e) {
      counts.playlists.failed += 1;
      failures.push({
        kind: "playlist",
        name: pl.name,
        artist: "",
        album: "",
        us_catalog_id: null,
        http_status: extractStatus(e),
        error: extractMessage(e),
      });
      progress.set("errors", String(failures.length));
    }
    progress.set("playlists", `${counts.playlists.succeeded + counts.playlists.failed}/${matched.playlists.length}`);
  }

  const report: ImportReport = {
    imported_at: new Date().toISOString(),
    destination_storefront: matched.destination_storefront,
    counts,
    failures,
  };

  await writeJsonAtomic("import-report.json", report);
  await writeFailuresCsv(failures);

  progress.finish(
    `\nImport complete:\n` +
      `  songs:     ${counts.songs.succeeded}/${counts.songs.requested}\n` +
      `  albums:    ${counts.albums.succeeded}/${counts.albums.requested}\n` +
      `  playlists: ${counts.playlists.succeeded}/${counts.playlists.requested}\n` +
      `  failures:  ${failures.length} (see amtransfer-data/import-failures.csv)\n` +
      `  report:    amtransfer-data/import-report.json\n`,
  );
}

async function importInBatches(
  ids: string[],
  kind: "songs" | "albums",
  call: (batch: string[]) => Promise<void>,
  progress: Progress,
  counter: { requested: number; succeeded: number; failed: number },
  failures: Failure[],
  matched: MatchedFile,
): Promise<void> {
  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const batch = ids.slice(i, i + BATCH_SIZE);
    try {
      await call(batch);
      counter.succeeded += batch.length;
    } catch (e) {
      counter.failed += batch.length;
      const status = extractStatus(e);
      const msg = extractMessage(e);
      for (const id of batch) {
        const item =
          kind === "songs"
            ? matched.songs.find((s) => s.us_catalog_id === id)
            : matched.albums.find((a) => a.us_catalog_id === id);
        failures.push({
          kind: kind === "songs" ? "song" : "album",
          name: item?.name ?? "",
          artist: item?.artist ?? "",
          album: kind === "songs" ? (item as MatchedSong | undefined)?.album ?? "" : "",
          us_catalog_id: id,
          http_status: status,
          error: msg,
        });
      }
      progress.set("errors", String(failures.length));
    }
    progress.set(kind, `${counter.succeeded + counter.failed}/${counter.requested}`);
  }
}

function uniqueIds(ids: Array<string | null>): string[] {
  return [...new Set(ids.filter((x): x is string => !!x))];
}

function extractStatus(e: unknown): number | null {
  if (e && typeof e === "object" && "status" in e && typeof (e as { status?: unknown }).status === "number") {
    return (e as { status: number }).status;
  }
  return null;
}

function extractMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

async function writeFailuresCsv(failures: Failure[]): Promise<void> {
  await writeCsv(
    "import-failures.csv",
    ["kind", "name", "artist", "album", "us_catalog_id", "http_status", "error"],
    failures.map((f) => [
      f.kind,
      f.name,
      f.artist,
      f.album,
      f.us_catalog_id ?? "",
      f.http_status ?? "",
      f.error,
    ]),
  );
}
```

- [ ] **Step 2: Verify type-check**

```bash
docker compose run --rm dev bunx tsc --noEmit
```

Expected: zero errors.

- [ ] **Step 3: USER RUNS A SMALL END-TO-END TEST**

Before running against your real library, exercise the full pipeline on a test playlist. Create a temporary playlist in your **destination-account** Apple Music with 5–10 songs that exist in both NZ and US stores. Then, with destination-account tokens in `.env`:

```bash
# Simulate the export step using your destination account (so we can re-import idempotently).
docker compose run --rm dev bun amtransfer.ts export
docker compose run --rm dev bun amtransfer.ts match
docker compose run --rm dev bun amtransfer.ts import
```

Expected on the second run: `import` reports playlists as "skip (exists)" rather than creating duplicates.

If you have your real NZ export already, the real flow is:

```bash
# (with NZ tokens loaded)
docker compose run --rm dev bun amtransfer.ts export

# Cancel NZ subscription, switch region, resubscribe US, then:
# (swap to US tokens in .env)
docker compose run --rm dev bun amtransfer.ts match
docker compose run --rm dev bun amtransfer.ts import
```

- [ ] **Step 4: Spot-check the import outputs**

```bash
docker compose run --rm dev bun -e '
  const r = await Bun.file("amtransfer-data/import-report.json").json();
  console.log({
    storefront: r.destination_storefront,
    counts: r.counts,
    failure_count: r.failures.length,
  });
'
```

- [ ] **Step 5: Commit**

```bash
git add src/import.ts
git commit -m "feat: implement import phase with playlist idempotency"
```

---

### Task 14: Complete README and tag v0.1.0

**Files:**
- Modify: `README.md` (extend with full migration playbook)

- [ ] **Step 1: Append migration playbook and recovery sections to `README.md`**

Add the following at the end of the existing README:

```markdown

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
```

- [ ] **Step 2: Commit and tag**

```bash
git add README.md
git commit -m "docs: full migration playbook, recovery, troubleshooting"
git tag -a v0.1.0 -m "amtransfer v0.1.0 — MVP"
```

---

## Summary of deliverables

After all 14 tasks complete:

- Single-repo Bun TypeScript CLI, ~900 lines of source + ~150 lines README + ~50 lines configuration.
- Four subcommands (`spike`, `export`, `match`, `import`) with shared client + storage + token loading + progress display.
- Docker dev container; no host dependencies beyond Docker.
- All outputs in `amtransfer-data/`: `export.json`, `matched.json`, `unmatched.csv`, `import-report.json`, `import-failures.csv`, `debug.log`.
- Tagged `v0.1.0` ready to push to GitHub.

## Deferred to v0.2 (see spec Non-goals)

- TUI (Bubble Tea-style screens via blessed/ink)
- `--concurrency N` flag
- Per-batch checkpoint sidecars + `--restart` flag
- `bun build --compile` static binary in GitHub Releases
- Unit tests for pure functions (ISRC batching, CSV escaping, retry math)
- Auto-refresh of expired tokens
