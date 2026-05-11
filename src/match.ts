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
