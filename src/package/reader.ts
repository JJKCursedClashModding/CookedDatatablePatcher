import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  readExportMap,
  readImportMap,
  readNameMap,
  resolveName,
  resolvePackageIndex,
  type ObjectExport,
} from "./maps.js";
import { extendPackageNameMap } from "./nameMap.js";
import { readPackageSummary, readPackageSummaryWithOffsets } from "./summary.js";

export interface LoadedPackage {
  readonly summary: ReturnType<typeof readPackageSummary>;
  readonly names: readonly string[];
  readonly imports: ReturnType<typeof readImportMap>;
  readonly exports: readonly ObjectExport[];
  readonly uasset: Buffer;
  readonly uexp: Buffer;
  readonly mainExport: ObjectExport;
  readonly exportBlob: Buffer;
}

export function loadCookedPackage(uassetPath: string, uasset: Buffer, uexp: Buffer): LoadedPackage {
  const summary = readPackageSummary(uasset);
  const names = readNameMap(uasset, summary.nameOffset, summary.nameCount);
  const imports = readImportMap(uasset, summary.importOffset, summary.importCount);
  const exports = readExportMap(uasset, summary.exportOffset, summary.exportCount);

  if (exports.length === 0) {
    throw new Error("Package has no exports");
  }

  const mainExport = exports.find((e) => resolveName(names, e.objectNameIndex).endsWith("DataTable"))
    ?? exports.find((e) => e.isAsset)
    ?? exports[0];

  const exportOffsetInUexp = mainExport.serialOffset - summary.totalHeaderSize;
  if (exportOffsetInUexp < 0) {
    throw new Error(
      `Export serial offset ${mainExport.serialOffset} is before header end (${summary.totalHeaderSize})`,
    );
  }
  const exportBlob = uexp.subarray(exportOffsetInUexp, exportOffsetInUexp + mainExport.serialSize);
  if (exportBlob.length !== mainExport.serialSize) {
    throw new Error(
      `Export blob truncated: expected ${mainExport.serialSize} bytes, got ${exportBlob.length} at uexp+${exportOffsetInUexp}`,
    );
  }

  return { summary, names, imports, exports, uasset, uexp, mainExport, exportBlob };
}

export function loadCookedPackageFromDir(dir: string, tableName: string): LoadedPackage {
  const uasset = readFileSync(join(dir, `${tableName}.uasset`));
  const uexp = readFileSync(join(dir, `${tableName}.uexp`));
  return loadCookedPackage(join(dir, `${tableName}.uasset`), uasset, uexp);
}

export function patchExportSerialSize(uasset: Buffer, exportEntry: ObjectExport, newSize: number): Buffer {
  const out = Buffer.from(uasset);
  out.writeBigInt64LE(BigInt(newSize), exportEntry.serialSizeFileOffset);
  return out;
}

/** Extend .uasset name map for FNames (row keys, NameProperty values, enum-as-FName arrays) not already interned. */
export function ensureNamesInPackage(
  uasset: Buffer,
  names: readonly string[],
  required: readonly string[],
): { uasset: Buffer; names: readonly string[] } {
  const missing = [...new Set(required.filter((n) => n && !names.includes(n)))];
  if (missing.length === 0) return { uasset, names };
  const { summary, offsets } = readPackageSummaryWithOffsets(uasset);
  return extendPackageNameMap(uasset, summary, offsets, missing);
}

export function resolveRowStructName(
  names: readonly string[],
  imports: ReturnType<typeof readImportMap>,
  rowStructPackageIndex: number,
): string {
  const ref = resolvePackageIndex(rowStructPackageIndex);
  if (ref.kind === "import") {
    return resolveName(names, imports[ref.idx]?.objectNameIndex ?? 0);
  }
  throw new Error(`RowStruct must be an import, got package index ${rowStructPackageIndex}`);
}
