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
