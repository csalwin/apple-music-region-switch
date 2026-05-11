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
