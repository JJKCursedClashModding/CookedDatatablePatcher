import { BinaryReader, BinaryWriter, looksLikeUnversionedFragment, parseFNameText } from "../io/binary.js";
import type { SchemaRegistry, UsmapSchema } from "../schema/usmap.js";
import { readStruct, writeStruct, type JsonValue, type SerializeContext } from "../unversioned/serializer.js";
import type { LoadedPackage } from "../package/reader.js";
import { resolveRowStructName } from "../package/reader.js";

export interface DataTableRow {
  readonly name: string;
  readonly values: Record<string, JsonValue>;
  /** FName comparison index from the cooked export (required for suffix keys like CP_210). */
  readonly nameIndex?: number;
  /** FName instance number from the cooked export (0 = no suffix). */
  readonly nameNumber?: number;
}

export interface ParsedDataTable {
  readonly rowStructName: string;
  readonly rowStruct: UsmapSchema;
  readonly rows: DataTableRow[];
  readonly dataTableProps: Record<string, JsonValue>;
  /** Padding bytes between DataTable properties and row count (often empty). */
  readonly dataSectionPadding: Buffer;
}

const DATA_TABLE_SCHEMA = "DataTable";

/**
 * Find the TMap row blob after UDataTable properties.
 * Scans a short window for a plausible row-count + first FName + unversioned header word.
 */
function locateDataSection(reader: BinaryReader, names: readonly string[]): void {
  const start = reader.offset;
  const end = Math.min(start + 32, reader.bytes.length);
  for (let probe = start; probe + 12 <= end; probe += 4) {
    reader.seek(probe);
    const numRows = reader.readInt32();
    if (numRows <= 0 || numRows > 500_000) continue;

    const nameIdx = reader.readInt32();
    const nameNum = reader.readInt32();
    if (nameIdx < 0 || nameIdx >= names.length || nameNum < 0 || nameNum > 1_000_000) continue;

    if (reader.offset + 2 <= reader.bytes.length) {
      const packed = reader.bytes.readUInt16LE(reader.offset);
      const valueCount = packed >> 9;
      const skipNum = packed & 0x7f;
      // Accept zero-value last fragments (empty row structs) as well as normal headers.
      if (valueCount > 127 || skipNum > 127) continue;
      if (valueCount === 0 && (packed & 0x100) === 0 && !looksLikeUnversionedFragment(packed)) continue;
    }

    reader.seek(probe);
    return;
  }
  reader.seek(start);
}

function resolveRowStructSchema(
  pkg: LoadedPackage,
  registry: SchemaRegistry,
  rowStructPackageIndex: number,
): UsmapSchema {
  try {
    const rowStructName = resolveRowStructName(pkg.names, pkg.imports, rowStructPackageIndex);
    const rowStruct = registry.getFlattenedSchema(rowStructName);
    if (rowStruct) return rowStruct;
  } catch {
    // fall through
  }

  const assetName = pkg.names[pkg.mainExport.objectNameIndex] ?? "";
  const tableBase = tableBaseNameFromAsset(assetName);
  const rowStruct = registry.resolveRowStruct(tableBase);
  if (!rowStruct) {
    throw new Error(`Row struct schema not found for table ${assetName}`);
  }
  return registry.getFlattenedSchema(rowStruct.name) ?? rowStruct;
}

/** Decode export blob per DATATABLE_COOKED_FORMAT.md §4 / READING_COOKED_DATATABLES.md §6–§8. */
export function parseDataTableExport(
  pkg: LoadedPackage,
  registry: SchemaRegistry,
): ParsedDataTable {
  const ctx: SerializeContext = { names: pkg.names, registry };
  const reader = new BinaryReader(pkg.exportBlob);

  const dataTableSchema = registry.getFlattenedSchema(DATA_TABLE_SCHEMA);
  if (!dataTableSchema) throw new Error("Missing DataTable schema in usmap");

  const dataTableProps = readStruct(reader, dataTableSchema, ctx);
  const propertiesEnd = reader.offset;

  locateDataSection(reader, pkg.names);
  const dataSectionPadding = Buffer.from(pkg.exportBlob.subarray(propertiesEnd, reader.offset));

  const rowStruct = resolveRowStructSchema(pkg, registry, Number(dataTableProps.RowStruct ?? 0));
  const rowStructName = rowStruct.name;

  const numRows = reader.readInt32();
  const rows: DataTableRow[] = [];
  for (let i = 0; i < numRows; i++) {
    const rowName = reader.readFName(pkg.names);
    try {
      const values = readStruct(reader, rowStruct, ctx);
      rows.push({
        name: rowName.text,
        nameIndex: rowName.index,
        nameNumber: rowName.number,
        values,
      });
    } catch (err) {
      throw new Error(`Row ${i} "${rowName.text}" @${reader.offset}: ${(err as Error).message}`);
    }
  }

  return { rowStructName, rowStruct, rows, dataTableProps, dataSectionPadding };
}

export function serializeDataTableExport(
  parsed: ParsedDataTable,
  rows: DataTableRow[],
  pkg: LoadedPackage,
  registry: SchemaRegistry,
): Buffer {
  const ctx: SerializeContext = { names: pkg.names, registry };
  const writer = new BinaryWriter();

  const dataTableSchema = registry.getFlattenedSchema(DATA_TABLE_SCHEMA);
  if (!dataTableSchema) throw new Error("Missing DataTable schema in usmap");

  writeStruct(writer, dataTableSchema, parsed.dataTableProps, ctx, { mode: "delta" });
  writer.writeBytes(parsed.dataSectionPadding);
  writer.writeInt32(rows.length);

  for (const row of rows) {
    let nameIndex = row.nameIndex;
    let nameNumber = row.nameNumber ?? 0;
    if (nameIndex === undefined) {
      const parsedName = parseFNameText(pkg.names, row.name);
      if (!parsedName.found) {
        throw new Error(
          `Row name "${row.name}" is not in the package name map. ` +
            "Adding new row keys requires rebuilding the name map (READING_COOKED_DATATABLES.md §10).",
        );
      }
      nameIndex = parsedName.index;
      nameNumber = parsedName.number;
    }

    const rowWriter = new BinaryWriter();
    writeStruct(rowWriter, parsed.rowStruct, row.values, ctx, { mode: "dense" });
    writer.writeFName({ index: nameIndex, number: nameNumber });
    writer.writeBytes(rowWriter.toBuffer());
  }

  return writer.toBuffer();
}

export function tableBaseNameFromAsset(assetName: string): string {
  const match = assetName.match(/^(.+?)DataTable(\d+)?$/i);
  return match ? match[1] : assetName;
}

export type ModPatch = Record<string, Record<string, JsonValue>>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validate and normalize a _ModManager JSON document. */
export function parseModPatch(raw: unknown, sourceLabel = "patch JSON"): ModPatch {
  if (!isPlainObject(raw)) {
    throw new Error(`${sourceLabel}: expected a JSON object of rowName -> field map`);
  }

  const patch: Record<string, Record<string, JsonValue>> = {};
  for (const [rowName, fields] of Object.entries(raw)) {
    if (typeof rowName !== "string" || rowName.length === 0) {
      throw new Error(`${sourceLabel}: row keys must be non-empty strings`);
    }
    if (!isPlainObject(fields)) {
      throw new Error(`${sourceLabel}: row "${rowName}" must be an object of field -> value`);
    }
    patch[rowName] = fields as Record<string, JsonValue>;
  }
  return patch;
}

export function applyModPatch(rows: DataTableRow[], patch: ModPatch, addRows: boolean): {
  rows: DataTableRow[];
  merged: number;
  added: number;
  missing: number;
} {
  const byName = new Map(
    rows.map((r) => [
      r.name,
      { name: r.name, values: { ...r.values }, nameIndex: r.nameIndex, nameNumber: r.nameNumber },
    ]),
  );
  let merged = 0;
  let added = 0;
  let missing = 0;

  for (const [rowName, patchValues] of Object.entries(patch)) {
    const existing = byName.get(rowName);
    if (existing) {
      for (const [key, value] of Object.entries(patchValues)) {
        existing.values[key] = value;
      }
      merged++;
    } else if (addRows) {
      byName.set(rowName, {
        name: rowName,
        values: { ID: rowName, ...patchValues },
        nameIndex: undefined,
        nameNumber: undefined,
      });
      added++;
    } else {
      missing++;
    }
  }

  return { rows: [...byName.values()], merged, added, missing };
}
