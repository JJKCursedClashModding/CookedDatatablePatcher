import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fNameComparisonIndexString, parseFNameText } from "./io/binary.js";
import { parseUsmap, SchemaRegistry } from "./schema/usmap.js";
import {
  loadCookedPackage,
  loadCookedPackageFromDir,
  patchExportSerialSize,
  ensureNamesInPackage,
} from "./package/reader.js";
import {
  applyModPatch,
  parseDataTableExport,
  parseModPatch,
  serializeDataTableExport,
} from "./datatable/patch.js";
import { collectRequiredFNameStrings } from "./unversioned/serializer.js";

export const DEFAULT_USMAP = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "mappings.usmap",
);

export interface PatchOptions {
  readonly inputDir: string;
  readonly outputDir: string;
  readonly tableAssetName: string;
  readonly patchJsonPath: string;
  readonly usmapPath?: string;
  readonly addRows?: boolean;
}

export interface PatchResult {
  readonly table: string;
  readonly merged: number;
  readonly added: number;
  readonly missing: number;
  readonly oldExportSize: number;
  readonly newExportSize: number;
  readonly outputUasset: string;
  readonly outputUexp: string;
}

export function patchCookedDataTable(options: PatchOptions): PatchResult {
  const usmapPath = options.usmapPath ?? DEFAULT_USMAP;
  const registry = new SchemaRegistry(parseUsmap(readFileSync(usmapPath)));
  const pkg = loadCookedPackageFromDir(options.inputDir, options.tableAssetName);
  const patch = parseModPatch(JSON.parse(readFileSync(options.patchJsonPath, "utf8")), options.patchJsonPath);

  const parsed = parseDataTableExport(pkg, registry);
  const patchResult = applyModPatch(parsed.rows, patch, options.addRows ?? true);

  const patchRowNames = new Set(Object.keys(patch));
  const requiredNames = new Set<string>();
  for (const row of patchResult.rows) {
    if (!patchRowNames.has(row.name)) continue;
    const rowKey = fNameComparisonIndexString(pkg.names, row.name);
    if (rowKey) requiredNames.add(rowKey);
    for (const name of collectRequiredFNameStrings(parsed.rowStruct, row.values, pkg.names, registry)) {
      requiredNames.add(name);
    }
  }

  let uasset = Buffer.from(pkg.uasset);
  let names = pkg.names;
  if (requiredNames.size > 0) {
    const extended = ensureNamesInPackage(uasset, names, [...requiredNames]);
    uasset = Buffer.from(extended.uasset);
    names = extended.names;
  }

  const rows = patchResult.rows.map((row) => {
    const parsedName = parseFNameText(names, row.name);
    if (!parsedName.found) {
      throw new Error(`Row name "${row.name}" could not be added to the package name map`);
    }
    return { ...row, nameIndex: parsedName.index, nameNumber: parsedName.number };
  });

  const pkgForWrite = loadCookedPackage(
    join(options.inputDir, `${options.tableAssetName}.uasset`),
    uasset,
    pkg.uexp,
  );
  const newExport = serializeDataTableExport(parsed, rows, pkgForWrite, registry);

  const outUasset = join(options.outputDir, `${options.tableAssetName}.uasset`);
  const outUexp = join(options.outputDir, `${options.tableAssetName}.uexp`);
  mkdirSync(options.outputDir, { recursive: true });

  const exportOffsetInUexp = pkg.mainExport.serialOffset - pkg.summary.totalHeaderSize;
  const oldExportSize = pkg.mainExport.serialSize;
  let newUexp: Buffer;
  if (newExport.length <= oldExportSize) {
    newUexp = Buffer.from(pkg.uexp);
    newExport.copy(newUexp, exportOffsetInUexp);
    if (newExport.length < oldExportSize) {
      newUexp.fill(0, exportOffsetInUexp + newExport.length, exportOffsetInUexp + oldExportSize);
    }
  } else {
    const tail = pkg.uexp.subarray(exportOffsetInUexp + oldExportSize);
    newUexp = Buffer.concat([
      pkg.uexp.subarray(0, exportOffsetInUexp),
      newExport,
      tail,
    ]);
  }
  const patchedUasset = patchExportSerialSize(uasset, pkgForWrite.mainExport, newExport.length);

  writeFileSync(outUasset, patchedUasset);
  writeFileSync(outUexp, newUexp);

  return {
    table: options.tableAssetName,
    merged: patchResult.merged,
    added: patchResult.added,
    missing: patchResult.missing,
    oldExportSize: pkg.mainExport.serialSize,
    newExportSize: newExport.length,
    outputUasset: outUasset,
    outputUexp: outUexp,
  };
}
