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
