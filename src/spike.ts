import { paginate, request, setTokens } from "./client.ts";
import type { ApiList, LibraryPlaylist, LibrarySong, Storefront, Tokens } from "./types.ts";

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
    for await (const pl of paginate<LibraryPlaylist>("/v1/me/library/playlists?limit=100")) {
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

  const playlistCreated = results.find(
    (r) => r.name === "POST /v1/me/library/playlists",
  )?.status === "PASS";
  if (playlistCreated) {
    process.stdout.write(
      `\nNote: the playlist named "${SPIKE_PLAYLIST_NAME}" was added to your library.\n` +
        `You can delete it manually from music.apple.com if you don't want it kept.\n`,
    );
  }

  if (!allPass) process.exitCode = 1;
}

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
