import packageJson from "./package.json" with { type: "json" };
import { loadTokens } from "./src/tokens.ts";
import { initStorage } from "./src/storage.ts";
import { setTokens } from "./src/client.ts";
import { runSpike } from "./src/spike.ts";
import { runExport } from "./src/export.ts";
import { runMatch } from "./src/match.ts";
import { runImport } from "./src/import.ts";

const VERSION: string = packageJson.version;

const USAGE = `\
amtransfer ${VERSION} — migrate an Apple Music library across an Apple ID region change

Usage:
  bun amtransfer.ts <command>

Commands:
  spike     Validate that the harvested-token auth pattern works for reads & writes
  export    Snapshot the source-account library to amtransfer-data/export.json
  match     Resolve every item against the destination storefront via ISRC/UPC
  import    Write matched items into the destination account

Flags:
  --version, -v   Print version and exit
  --help, -h      Print this help and exit

Tokens are read from AM_DEV_TOKEN and AM_USER_TOKEN env vars, or prompted for
interactively if either is unset. See README for token-harvesting steps.
`;

async function main(): Promise<void> {
  const cmd = process.argv[2];

  if (cmd === "--version" || cmd === "-v" || cmd === "version") {
    process.stdout.write(`${VERSION}\n`);
    return;
  }

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
