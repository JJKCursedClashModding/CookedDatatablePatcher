/**
 * Round-trip every cooked DataTable: parse → serialize → byte-compare export blob.
 * Also spot-check a _ModManager patch against one table.
 *
 * Usage: npx tsx scripts/round-trip-test.ts [limit]
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseUsmap, SchemaRegistry } from "../src/schema/usmap.js";
import { loadCookedPackageFromDir } from "../src/package/reader.js";
import { parseDataTableExport, serializeDataTableExport } from "../src/datatable/patch.js";
import { patchCookedDataTable } from "../src/patchTable.js";
import { readdirSync } from "node:fs";

const root = resolve(import.meta.dirname, "..");
const cookedDir = resolve(root, "../CookedDatatables");
const patchesDir = resolve(root, "../Patches");
const usmapPath = join(root, "mappings.usmap");
const limit = process.argv[2] ? Number(process.argv[2]) : Infinity;

const registry = new SchemaRegistry(parseUsmap(readFileSync(usmapPath)));
const tables = readdirSync(cookedDir)
  .filter((f) => f.endsWith(".uasset"))
  .map((f) => f.replace(/\.uasset$/, ""))
  .sort()
  .slice(0, Number.isFinite(limit) ? limit : undefined);

type Result = {
  table: string;
  ok: boolean;
  rows: number;
  origSize: number;
  newSize: number;
  firstDiff: number;
  error?: string;
};

const results: Result[] = [];
let okCount = 0;

for (const table of tables) {
  try {
    const pkg = loadCookedPackageFromDir(cookedDir, table);
    const parsed = parseDataTableExport(pkg, registry);
    const round = serializeDataTableExport(parsed, parsed.rows, pkg, registry);
    const orig = pkg.exportBlob;

    let firstDiff = -1;
    const n = Math.max(orig.length, round.length);
    for (let i = 0; i < n; i++) {
      if (orig[i] !== round[i]) {
        firstDiff = i;
        break;
      }
    }

    const ok = firstDiff < 0 && orig.length === round.length;
    if (ok) okCount++;
    results.push({
      table,
      ok,
      rows: parsed.rows.length,
      origSize: orig.length,
      newSize: round.length,
      firstDiff,
    });
  } catch (err) {
    results.push({
      table,
      ok: false,
      rows: 0,
      origSize: 0,
      newSize: 0,
      firstDiff: -1,
      error: (err as Error).message,
    });
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`Round-trip: ${okCount}/${results.length} exact matches`);
if (failed.length > 0) {
  console.log(`\nFailures (${failed.length}):`);
  for (const f of failed.slice(0, 40)) {
    if (f.error) {
      console.log(`  FAIL ${f.table}: ${f.error}`);
    } else {
      console.log(
        `  DIFF ${f.table}: rows=${f.rows} size ${f.origSize}->${f.newSize} firstDiff@${f.firstDiff}`,
      );
    }
  }
  if (failed.length > 40) console.log(`  ... and ${failed.length - 40} more`);
}

// Spot-check: patch one table that has a JSON, then re-parse output
const samplePatch = "DamageDataTable5";
const patchJson = join(patchesDir, `${samplePatch}.json`);
const outDir = join(root, "_roundtrip_tmp");
try {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const before = loadCookedPackageFromDir(cookedDir, samplePatch);
  const beforeParsed = parseDataTableExport(before, registry);

  const patchResult = patchCookedDataTable({
    tableAssetName: samplePatch,
    patchJsonPath: patchJson,
    inputDir: cookedDir,
    outputDir: outDir,
    usmapPath,
    addRows: true,
  });

  const after = loadCookedPackageFromDir(outDir, samplePatch);
  const afterParsed = parseDataTableExport(after, registry);
  const patchDoc = JSON.parse(readFileSync(patchJson, "utf8")) as Record<string, Record<string, unknown>>;
  const patchedRowNames = Object.keys(patchDoc);
  let fieldHits = 0;
  let fieldMiss = 0;
  for (const rowName of patchedRowNames) {
    const row = afterParsed.rows.find((r) => r.name === rowName);
    if (!row) {
      fieldMiss++;
      continue;
    }
    for (const [k, v] of Object.entries(patchDoc[rowName])) {
      if (JSON.stringify(row.values[k]) === JSON.stringify(v)) fieldHits++;
      else fieldMiss++;
    }
  }

  console.log(`\nPatch spot-check (${samplePatch}):`);
  console.log(
    `  merged=${patchResult.merged} added=${patchResult.added} export ${patchResult.oldExportSize} -> ${patchResult.newExportSize}`,
  );
  console.log(`  rows before=${beforeParsed.rows.length} after=${afterParsed.rows.length}`);
  console.log(`  patch field matches=${fieldHits} mismatches=${fieldMiss}`);

  writeFileSync(
    join(outDir, "round-trip-summary.json"),
    JSON.stringify({ okCount, total: results.length, failed: failed.length, patch: patchResult }, null, 2),
  );
} catch (err) {
  console.error(`\nPatch spot-check failed: ${(err as Error).message}`);
  process.exitCode = 1;
}

if (failed.length > 0) process.exitCode = 1;
