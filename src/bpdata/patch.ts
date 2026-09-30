/**
 * Per-asset Blueprint parameter patching.
 *
 * Package layout (JJK CC cooked BPs, verified on all 5 parameter assets):
 * - `.uasset` FObjectExport entries are 96 bytes each:
 *   `[44B prefix incl. serialSize/serialOffset][32B: 7 bools-as-int32 +
 *   PackageFlags][20B: 5 int32 preload dependencies]`.
 *   Stride is derived as `(dependsOffset - exportOffset) / exportCount`.
 * - 2 exports: `<Asset>_C` (104B BlueprintGeneratedClass) + `Default__<Asset>_C`
 *   (the CDO holding the parameter maps). The CDO is the last export.
 * - The CDO blob is parsed with `bpdata/codec.ts` and re-serialized after
 *   cloning donor rows. `.uexp` is spliced; trailing bytes preserved.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { BinaryReader, BinaryWriter } from "../io/binary.js";
import { parseUsmap, SchemaRegistry, type UsmapSchema } from "../schema/usmap.js";
import { readImportMap, readNameMap, resolveName, type ObjectImport } from "../package/maps.js";
import {
  collectRequiredFNameStrings,
  type JsonValue as TableJsonValue,
} from "../unversioned/serializer.js";
import { readPackageSummaryWithOffsets } from "../package/summary.js";
import { extendPackageNameMap } from "../package/nameMap.js";
import { DEFAULT_USMAP } from "../patchTable.js";
import { NATIVE_STRUCTS, readStruct, writeStruct, type BpContext, type BpJsonValue } from "./codec.js";
import {
  ASSET_BY_SHORT_NAME,
  parseParameterPatch,
  type BpParameterAsset,
  type ParameterPatch,
} from "./parameters.js";

export interface BpPatchResult {
  readonly shortName: string;
  readonly asset: string;
  readonly added: number;
  readonly skipped: number;
  readonly replaced: number;
  readonly oldExportSize: number;
  readonly newExportSize: number;
  readonly outputUasset: string;
  readonly outputUexp: string;
}

interface LoadedBp {
  uasset: Buffer;
  uexp: Buffer;
  names: readonly string[];
  imports: readonly ObjectImport[];
  exportOffset: number;
  dependsOffset: number;
  exportCount: number;
  exportStride: number;
  cdoIndex: number;
  totalHeaderSize: number;
}

function readExportPrefix(
  uasset: Buffer,
  exportOffset: number,
  stride: number,
  index: number,
): { nameIndex: number; serialSize: number; serialOffset: number } {
  const o = exportOffset + index * stride;
  return {
    nameIndex: uasset.readInt32LE(o + 16),
    serialSize: Number(uasset.readBigInt64LE(o + 28)),
    serialOffset: Number(uasset.readBigInt64LE(o + 36)),
  };
}

function loadBpPackage(inputDir: string, assetName: string): LoadedBp {
  const uasset = readFileSync(join(inputDir, `${assetName}.uasset`));
  const uexp = readFileSync(join(inputDir, `${assetName}.uexp`));
  const { summary } = readPackageSummaryWithOffsets(uasset);
  const names = readNameMap(uasset, summary.nameOffset, summary.nameCount);
  const imports = readImportMap(uasset, summary.importOffset, summary.importCount);

  const span = summary.dependsOffset - summary.exportOffset;
  if (summary.exportCount <= 0 || span <= 0 || span % summary.exportCount !== 0) {
    throw new Error(
      `${assetName}: cannot derive export stride ` +
        `(exportOffset=${summary.exportOffset} dependsOffset=${summary.dependsOffset} count=${summary.exportCount})`,
    );
  }
  const stride = span / summary.exportCount;
  if (stride < 76 || stride > 256) {
    throw new Error(`${assetName}: implausible export stride ${stride}`);
  }

  // The CDO is the export whose name starts with Default__ (last export in practice).
  let cdoIndex = -1;
  for (let i = 0; i < summary.exportCount; i++) {
    const { nameIndex } = readExportPrefix(uasset, summary.exportOffset, stride, i);
    const nm = names[nameIndex] ?? "";
    if (nm.startsWith("Default__")) cdoIndex = i;
  }
  if (cdoIndex < 0) {
    throw new Error(`${assetName}: no Default__ CDO export found (${summary.exportCount} exports)`);
  }

  return {
    uasset: Buffer.from(uasset),
    uexp: Buffer.from(uexp),
    names,
    imports,
    exportOffset: summary.exportOffset,
    dependsOffset: summary.dependsOffset,
    exportCount: summary.exportCount,
    exportStride: stride,
    cdoIndex,
    totalHeaderSize: summary.totalHeaderSize,
  };
}

function getMapProp(
  cdo: Record<string, BpJsonValue>,
  mapProp: string,
  assetName: string,
): Record<string, BpJsonValue> {
  const v = cdo[mapProp];
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    throw new Error(`${assetName}: CDO property ${mapProp} is not a map`);
  }
  return v as Record<string, BpJsonValue>;
}

/** ExchangeImage entry value -> row array (`{ Array: [...] }` struct with single `Array` prop). */
function getEntryRows(entry: BpJsonValue, assetName: string): BpJsonValue[] {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error(`${assetName}: ImageOffsetParameterMap entry is not a struct`);
  }
  const arr = (entry as Record<string, BpJsonValue>).Array;
  if (!Array.isArray(arr)) {
    throw new Error(`${assetName}: ImageOffsetParameterMap entry has no Array`);
  }
  return arr;
}

function rowId(row: BpJsonValue): string | null {
  if (row && typeof row === "object" && !Array.isArray(row)) {
    const id = (row as Record<string, BpJsonValue>).ID;
    if (typeof id === "string") return id;
  }
  return null;
}

function isObject(value: BpJsonValue): value is Record<string, BpJsonValue> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function assertNewKey(
  map: Record<string, BpJsonValue>,
  newId: string,
  shortName: string,
  assetName: string,
): void {
  if (Object.prototype.hasOwnProperty.call(map, newId)) {
    throw new Error(
      `${shortName}.json: key "${newId}" already exists in base ${assetName}; ` +
        `new characters must use new IDs`,
    );
  }
}

/** Recursive unknown-field check against usmap schemas (authoring aid). */
function assertNoUnknownFields(
  registry: SchemaRegistry,
  schema: UsmapSchema,
  value: Record<string, BpJsonValue>,
  pathLabel: string,
  assetName: string,
): void {
  const byName = new Map(schema.properties.map((p) => [p.name, p]));
  for (const [key, sub] of Object.entries(value)) {
    if (key.startsWith("$")) continue; // author annotations
    const prop = byName.get(key);
    if (!prop) {
      throw new Error(
        `${pathLabel}: unknown field "${key}" for ${schema.name} in ${assetName}; ` +
          `valid fields: ${schema.properties.map((p) => p.name).join(", ")}`,
      );
    }
    // Native structs (Vector, LinearColor/Hex, IntPoint, …) are schemaless on
    // the wire — extra keys like Hex are ignored on write, not errors.
    const isNative = prop.type === "StructProperty" && !!prop.structName && NATIVE_STRUCTS.has(prop.structName);
    if (prop.type === "StructProperty" && prop.structName && isObject(sub) && !isNative) {
      const nested = registry.getFlattenedSchema(prop.structName);
      if (nested) assertNoUnknownFields(registry, nested, sub, `${pathLabel}.${key}`, assetName);
    } else if ((prop.type === "ArrayProperty" || prop.type === "SetProperty") && Array.isArray(sub)) {
      const inner = prop.innerType;
      if (inner?.type === "StructProperty" && inner.structName) {
        const nested = registry.getFlattenedSchema(inner.structName);
        if (nested) {
          for (const el of sub) {
            if (isObject(el)) assertNoUnknownFields(registry, nested, el, `${pathLabel}.${key}[]`, assetName);
          }
        }
      }
    } else if (prop.type === "MapProperty" && isObject(sub)) {
      const valueType = prop.valueType;
      if (valueType?.type === "StructProperty" && valueType.structName) {
        const nested = registry.getFlattenedSchema(valueType.structName);
        if (nested) {
          for (const [k, v] of Object.entries(sub)) {
            if (isObject(v)) assertNoUnknownFields(registry, nested, v, `${pathLabel}.${key}.${k}`, assetName);
          }
        }
      }
    }
  }
}

/** Strip an `EType::` prefix so entry names match either spelling. */
function shortEntryName(key: string): string {
  const i = key.indexOf("::");
  return i >= 0 ? key.slice(i + 2) : key;
}

/**
 * Resolve a sceneCapture reference string to its import package index.
 * Accepts a short character ID (`"CP_010"`) or a full package path; the
 * target must already be imported (all 48 vanilla capture assets are).
 */
function resolveCaptureImport(pkg: LoadedBp, target: string, label: string, assetName: string): number {
  const assetBase = target.includes("/")
    ? (target.split("/").pop() ?? target)
    : target.startsWith("GameWidgetCharacterSceneCapture_")
      ? target
      : `GameWidgetCharacterSceneCapture_${target}_BP`;
  for (let i = 0; i < pkg.imports.length; i++) {
    const imp = pkg.imports[i];
    if (resolveName(pkg.names, imp.objectNameIndex) === assetBase) {
      return -(i + 1);
    }
  }
  const available = pkg.imports
    .map((imp) => resolveName(pkg.names, imp.objectNameIndex))
    .filter((n) => n.startsWith("GameWidgetCharacterSceneCapture_"));
  throw new Error(
    `${label}: capture asset "${target}" is not imported by ${assetName} ` +
      `(looked for "${assetBase}"). Available: ${available.slice(0, 8).join(", ")}${
        available.length > 8 ? ` (+${available.length - 8} more)` : ""
      }`,
  );
}

export interface PatchBpOptions {
  readonly inputDir: string;
  readonly outputDir: string;
  readonly shortName: string;
  readonly patchJsonPath: string;
  readonly usmapPath?: string;
}

export function patchBpParameter(options: PatchBpOptions): BpPatchResult {
  const asset: BpParameterAsset | undefined = ASSET_BY_SHORT_NAME.get(options.shortName);
  if (!asset) {
    const valid = [...ASSET_BY_SHORT_NAME.keys()].join(", ");
    throw new Error(`${options.patchJsonPath}: unknown parameter file; expected one of: ${valid}`);
  }
  const patch: ParameterPatch = parseParameterPatch(
    JSON.parse(readFileSync(options.patchJsonPath, "utf8")),
    options.patchJsonPath,
  );

  const registry = new SchemaRegistry(parseUsmap(readFileSync(options.usmapPath ?? DEFAULT_USMAP)));
  const schema = registry.getFlattenedSchema(asset.className);
  if (!schema) throw new Error(`${asset.assetName}: missing usmap schema ${asset.className}`);
  const mapSchemaProp = schema.properties.find((p) => p.name === asset.mapProp);
  if (!mapSchemaProp) throw new Error(`${asset.assetName}: schema ${asset.className} has no ${asset.mapProp}`);

  const pkg = loadBpPackage(options.inputDir, asset.assetName);
  const cdoPrefix = readExportPrefix(pkg.uasset, pkg.exportOffset, pkg.exportStride, pkg.cdoIndex);
  const blobOff = cdoPrefix.serialOffset - pkg.totalHeaderSize;
  const blob = Buffer.from(pkg.uexp.subarray(blobOff, blobOff + cdoPrefix.serialSize));
  if (blob.length !== cdoPrefix.serialSize) {
    throw new Error(`${asset.assetName}: CDO blob truncated`);
  }

  const zeroStates: WeakMap<object, ReadonlySet<string>> = new WeakMap();
  const ctx: BpContext = { names: pkg.names, registry, zeroStates };
  const cdoReader = new BinaryReader(blob);
  const cdo = readStruct(cdoReader, schema, ctx);
  const cdoTail = Buffer.from(blob.subarray(cdoReader.offset));
  const map = getMapProp(cdo, asset.mapProp, asset.assetName);

  let added = 0;
  let skipped = 0;
  let replaced = 0;
  const requiredNames = new Set<string>();

  if (asset.valueKind === "rows") {
    // ExchangeImage: literal per-costume rows.
    // `{ "CP_300_00": { "Offset": {X,Y}, "entries"?: { "<Entry>": {X,Y} } } }`
    // Without `entries` the row goes to every entry; with an `entries` map it
    // goes to exactly those entries (per-entry offsets).
    const rowSchema = (() => {
      const entryStruct = mapSchemaProp.valueType?.structName
        ? registry.getFlattenedSchema(mapSchemaProp.valueType.structName)
        : undefined;
      const arrayProp = entryStruct?.properties.find((p) => p.name === "Array");
      const rowName = arrayProp?.innerType?.structName;
      const rowSchema = rowName ? registry.getFlattenedSchema(rowName) : undefined;
      if (!rowSchema) throw new Error(`${asset.assetName}: cannot resolve exchangeImage row schema`);
      return rowSchema;
    })();
    const baseByShort = new Map<string, string>();
    for (const k of Object.keys(map)) baseByShort.set(shortEntryName(k), k);
    for (const [newId, rawValue] of Object.entries(patch)) {
      const label = `${options.shortName}.json "${newId}"`;
      if (!isObject(rawValue)) {
        throw new Error(`${label}: expected { "Offset": {X,Y}, "entries"?: {...} }`);
      }
      const offset = rawValue.Offset;
      if (!isObject(offset)) {
        throw new Error(`${label}: missing "Offset": {X,Y}`);
      }
      assertNoUnknownFields(registry, rowSchema, { ID: newId, Offset: offset }, label, asset.assetName);
      let targets: Array<{ entryKey: string; offset: Record<string, BpJsonValue> }>;
      if (rawValue.entries === undefined) {
        targets = Object.keys(map).map((entryKey) => ({ entryKey, offset }));
      } else {
        if (!isObject(rawValue.entries)) {
          throw new Error(`${label}: "entries" must be a map of entry name -> {X,Y}`);
        }
        targets = [];
        for (const [entryName, entryOffset] of Object.entries(rawValue.entries)) {
          const full = baseByShort.get(shortEntryName(entryName));
          if (!full) {
            throw new Error(
              `${label}: unknown image entry "${entryName}"; valid: ${[...baseByShort.keys()].join(", ")}`,
            );
          }
          if (!isObject(entryOffset)) {
            throw new Error(`${label}: entry "${entryName}" must be {X,Y}`);
          }
          targets.push({ entryKey: full, offset: entryOffset });
        }
        if (targets.length === 0) {
          skipped++;
          continue;
        }
      }
      // New costume IDs must not collide with base rows anywhere.
      for (const entryKey of Object.keys(map)) {
        const rows = getEntryRows(map[entryKey], asset.assetName);
        if (rows.some((r) => rowId(r) === newId)) {
          throw new Error(
            `${options.shortName}.json: key "${newId}" already exists in base ${asset.assetName}; ` +
              `new costumes must use new IDs`,
          );
        }
      }
      requiredNames.add(newId);
      for (const { entryKey, offset: entryOffset } of targets) {
        const rows = getEntryRows(map[entryKey], asset.assetName) as BpJsonValue[];
        rows.push({ ID: newId, Offset: { ...(entryOffset as Record<string, BpJsonValue>) } });
        added++;
      }
    }
  } else if (asset.valueKind === "ref") {
    // SceneCapture: literal asset references (short ID or package path).
    for (const [newId, rawValue] of Object.entries(patch)) {
      const label = `${options.shortName}.json "${newId}"`;
      assertNewKey(map, newId, options.shortName, asset.assetName);
      if (typeof rawValue !== "string" || rawValue.length === 0) {
        throw new Error(`${label}: expected a capture asset reference string`);
      }
      map[newId] = resolveCaptureImport(pkg, rawValue, label, asset.assetName);
      requiredNames.add(newId);
      added++;
    }
  } else {
    // Plain map-set of literal structs.
    const valueSchemaName = mapSchemaProp.valueType?.structName;
    const valueSchema = valueSchemaName ? registry.getFlattenedSchema(valueSchemaName) : undefined;
    if (!valueSchema) {
      throw new Error(`${asset.assetName}: cannot resolve value schema for ${asset.mapProp}`);
    }
    for (const [newId, rawValue] of Object.entries(patch)) {
      const label = `${options.shortName}.json "${newId}"`;
      assertNewKey(map, newId, options.shortName, asset.assetName);
      if (!isObject(rawValue)) {
        throw new Error(`${label}: expected a ${valueSchema.name} object`);
      }
      assertNoUnknownFields(registry, valueSchema, rawValue, label, asset.assetName);
      map[newId] = { ...(rawValue as Record<string, BpJsonValue>) };
      requiredNames.add(newId);
      for (const n of collectRequiredFNameStrings(
        valueSchema,
        rawValue as unknown as Record<string, TableJsonValue>,
        pkg.names,
        registry,
      )) {
        requiredNames.add(n);
      }
      added++;
    }
  }

  // Extend the name map for new IDs / costume IDs (BP export stride passed
  // through so export fixups land on the real 96B entries).
  let uasset = pkg.uasset;
  let names: readonly string[] = pkg.names;
  {
    const missing = [...requiredNames].filter((n) => !names.includes(n));
    if (missing.length > 0) {
      const { summary, offsets } = readPackageSummaryWithOffsets(uasset);
      const extended = extendPackageNameMap(uasset, summary, offsets, missing, pkg.exportStride);
      uasset = Buffer.from(extended.uasset);
      names = extended.names;
    }
  }

  const ctx2: BpContext = { names, registry, zeroStates };
  const writer = new BinaryWriter();
  writeStruct(writer, schema, cdo, ctx2);
  const newExport = Buffer.concat([writer.toBuffer(), cdoTail]);

  // Re-derive the CDO entry position in the (possibly grown) header. The
  // name-map extension already bumped its serialOffset by the header delta.
  const { summary: summary2 } = readPackageSummaryWithOffsets(uasset);
  const stride2 = (summary2.dependsOffset - summary2.exportOffset) / summary2.exportCount;
  const entryOff2 = summary2.exportOffset + pkg.cdoIndex * stride2;
  const newOff = Number(uasset.readBigInt64LE(entryOff2 + 36));

  const oldSize = cdoPrefix.serialSize;
  const oldOff = cdoPrefix.serialOffset;

  const outUexp = (() => {
    const offInUexp = oldOff - pkg.totalHeaderSize;
    const tail = pkg.uexp.subarray(offInUexp + oldSize);
    if (newExport.length <= oldSize) {
      const out = Buffer.from(pkg.uexp);
      newExport.copy(out, offInUexp);
      if (newExport.length < oldSize) out.fill(0, offInUexp + newExport.length, offInUexp + oldSize);
      return out;
    }
    return Buffer.concat([pkg.uexp.subarray(0, offInUexp), newExport, tail]);
  })();

  const outUasset = Buffer.from(uasset);
  outUasset.writeBigInt64LE(BigInt(newExport.length), entryOff2 + 28);
  outUasset.writeBigInt64LE(BigInt(newOff), entryOff2 + 36);

  mkdirSync(options.outputDir, { recursive: true });
  const outputUasset = join(options.outputDir, `${asset.assetName}.uasset`);
  const outputUexp = join(options.outputDir, `${asset.assetName}.uexp`);
  writeFileSync(outputUasset, outUasset);
  writeFileSync(outputUexp, outUexp);

  return {
    shortName: options.shortName,
    asset: asset.assetName,
    added,
    skipped,
    replaced,
    oldExportSize: oldSize,
    newExportSize: newExport.length,
    outputUasset,
    outputUexp,
  };
}
