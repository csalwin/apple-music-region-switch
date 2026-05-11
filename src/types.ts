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
