import { BinaryWriter } from "../io/binary.js";
import type { PackageFileSummary, PackageSummaryOffsets } from "./summary.js";
import { readExportMap, readNameMap } from "./maps.js";

/** One cooked name-map entry: FString + two uint16 hashes (JJK uses 0,0). */
export function writeNameMapEntry(name: string): Buffer {
  const writer = new BinaryWriter();
  const bytes = Buffer.from(name, "latin1");
  writer.writeInt32(bytes.length + 1);
  writer.writeBytes(bytes);
  writer.writeUInt8(0);
  writer.writeUInt16(0);
  writer.writeUInt16(0);
  return writer.toBuffer();
}

export function computeNameMapEntryOffset(buffer: Buffer, nameOffset: number, entryIndex: number): number {
  let off = nameOffset;
  for (let i = 0; i < entryIndex; i++) {
    const len = buffer.readInt32LE(off);
    const strBytes = len < 0 ? -len * 2 : len;
    off += 4 + strBytes + 4;
  }
  return off;
}

export function computeNameMapEnd(buffer: Buffer, nameOffset: number, nameCount: number): number {
  return computeNameMapEntryOffset(buffer, nameOffset, nameCount);
}

/** Export-referenced names precede import/header-only names (first /Script/ entry). */
export function inferNamesReferencedFromExportDataCount(names: readonly string[]): number {
  const scriptIdx = names.findIndex((n) => n.startsWith("/Script/"));
  return scriptIdx >= 0 ? scriptIdx : names.length;
}

function patchInt32(buf: Buffer, offset: number | undefined, delta: number): void {
  if (offset === undefined || offset < 0) return;
  const v = buf.readInt32LE(offset);
  if (v >= 0) buf.writeInt32LE(v + delta, offset);
}

function patchInt64(buf: Buffer, offset: number | undefined, delta: number): void {
  if (offset === undefined || offset < 0) return;
  const v = buf.readBigInt64LE(offset);
  if (v >= 0n) buf.writeBigInt64LE(v + BigInt(delta), offset);
}

function bumpFNameIndex(buf: Buffer, offset: number, threshold: number, delta: number): void {
  const idx = buf.readInt32LE(offset);
  if (idx >= threshold) buf.writeInt32LE(idx + delta, offset);
}

function patchImportMapNameIndices(
  buf: Buffer,
  importOffset: number,
  importCount: number,
  threshold: number,
  delta: number,
): void {
  let off = importOffset;
  for (let i = 0; i < importCount; i++) {
    bumpFNameIndex(buf, off, threshold, delta);
    off += 8;
    bumpFNameIndex(buf, off, threshold, delta);
    off += 8;
    off += 4;
    bumpFNameIndex(buf, off, threshold, delta);
    off += 8;
    off += 4;
  }
}

function patchOffsetFields(buf: Buffer, offsets: PackageSummaryOffsets, insertAt: number, delta: number): void {
  const bump = (off: number | undefined) => {
    if (off === undefined) return;
    const v = buf.readInt32LE(off);
    if (v >= insertAt) patchInt32(buf, off, delta);
  };

  bump(offsets.softObjectPathsOffset);
  bump(offsets.gatherableTextDataOffset);
  bump(offsets.exportOffset);
  bump(offsets.importOffset);
  bump(offsets.dependsOffset);
  bump(offsets.softPackageReferencesOffset);
  bump(offsets.searchableNamesOffset);
  bump(offsets.thumbnailTableOffset);
  bump(offsets.importTypeHierarchiesOffset);
  bump(offsets.preloadDependencyOffset);
  bump(offsets.assetRegistryDataOffset);
  bump(offsets.worldTileInfoDataOffset);
  bump(offsets.dataResourceOffset);

  if (offsets.bulkDataStartOffset !== undefined) {
    const v = buf.readBigInt64LE(offsets.bulkDataStartOffset);
    if (v >= BigInt(insertAt)) patchInt64(buf, offsets.bulkDataStartOffset, delta);
  }
  if (offsets.payloadTocOffset !== undefined) {
    const v = buf.readBigInt64LE(offsets.payloadTocOffset);
    if (v >= BigInt(insertAt)) patchInt64(buf, offsets.payloadTocOffset, delta);
  }

  patchInt32(buf, offsets.totalHeaderSize, delta);
}

export interface ExtendNameMapResult {
  readonly uasset: Buffer;
  readonly names: readonly string[];
  readonly added: ReadonlyMap<string, number>;
}

/**
 * Insert new export-referenced FNames before the header-only name section.
 * UE validates export FName indices against NamesReferencedFromExportDataCount.
 */
export function extendPackageNameMap(
  uasset: Buffer,
  summary: PackageFileSummary,
  offsets: PackageSummaryOffsets,
  newNames: readonly string[],
): ExtendNameMapResult {
  const existing = readNameMap(uasset, summary.nameOffset, summary.nameCount);
  const uniqueNew = [...new Set(newNames.filter((n) => n && !existing.includes(n)))];
  if (uniqueNew.length === 0) {
    return { uasset, names: existing, added: new Map() };
  }

  const refCount =
    offsets.namesReferencedFromExportDataCount !== undefined
      ? uasset.readInt32LE(offsets.namesReferencedFromExportDataCount)
      : inferNamesReferencedFromExportDataCount(existing);

  const insertAt = computeNameMapEntryOffset(uasset, summary.nameOffset, refCount);
  const newEntries = Buffer.concat(uniqueNew.map(writeNameMapEntry));
  const delta = newEntries.length;

  const out = Buffer.concat([uasset.subarray(0, insertAt), newEntries, uasset.subarray(insertAt)]);

  patchInt32(out, offsets.nameCount, uniqueNew.length);
  if (offsets.namesReferencedFromExportDataCount !== undefined) {
    patchInt32(out, offsets.namesReferencedFromExportDataCount, uniqueNew.length);
  }
  patchOffsetFields(out, offsets, insertAt, delta);

  patchImportMapNameIndices(
    out,
    summary.importOffset + delta,
    summary.importCount,
    refCount,
    uniqueNew.length,
  );

  const exports = readExportMap(out, summary.exportOffset + delta, summary.exportCount);
  for (const exp of exports) {
    bumpFNameIndex(out, exp.objectNameIndexFileOffset, refCount, uniqueNew.length);
    patchInt64(out, exp.serialOffsetFileOffset, delta);
  }

  const names = [...existing.slice(0, refCount), ...uniqueNew, ...existing.slice(refCount)];
  const added = new Map(uniqueNew.map((n, i) => [n, refCount + i]));
  return { uasset: out, names, added };
}
