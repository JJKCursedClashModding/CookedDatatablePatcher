import { BinaryReader } from "../io/binary.js";
import { PACKAGE_FILE_TAG, PKG, UE4_VER, UE5_1, UE5_VER } from "./versions.js";

export interface PackageFileSummary {
  readonly tag: number;
  readonly legacyFileVersion: number;
  readonly fileVersionUE4: number;
  readonly fileVersionUE5: number;
  readonly fileVersionLicenseeUE: number;
  readonly packageFlags: number;
  readonly totalHeaderSize: number;
  readonly packageName: string;
  readonly nameCount: number;
  readonly nameOffset: number;
  readonly softObjectPathsCount: number;
  readonly softObjectPathsOffset: number;
  readonly gatherableTextDataCount: number;
  readonly gatherableTextDataOffset: number;
  readonly exportCount: number;
  readonly exportOffset: number;
  readonly importCount: number;
  readonly importOffset: number;
  readonly dependsOffset: number;
  readonly preloadDependencyCount: number;
  readonly preloadDependencyOffset: number;
  readonly bulkDataStartOffset: bigint;
  readonly headerEndOffset: number;
  readonly hasUnversionedProperties: boolean;
  readonly isCooked: boolean;
}

/** File offsets of mutable FPackageFileSummary fields (for name-map extension). */
export interface PackageSummaryOffsets {
  readonly totalHeaderSize: number;
  readonly nameCount: number;
  readonly nameOffset: number;
  readonly softObjectPathsOffset?: number;
  readonly gatherableTextDataOffset: number;
  readonly exportOffset: number;
  readonly importOffset: number;
  readonly dependsOffset: number;
  readonly softPackageReferencesOffset?: number;
  readonly searchableNamesOffset?: number;
  readonly thumbnailTableOffset: number;
  readonly importTypeHierarchiesOffset?: number;
  readonly assetRegistryDataOffset: number;
  readonly bulkDataStartOffset: number;
  readonly worldTileInfoDataOffset: number;
  readonly preloadDependencyOffset?: number;
  readonly namesReferencedFromExportDataCount?: number;
  readonly payloadTocOffset?: number;
  readonly dataResourceOffset?: number;
}

export interface ParsedPackageSummary {
  readonly summary: PackageFileSummary;
  readonly offsets: PackageSummaryOffsets;
}

function readCustomVersionContainer(reader: BinaryReader): void {
  const count = reader.readInt32();
  for (let i = 0; i < count; i++) {
    reader.readBytes(16); // FGuid
    reader.readInt32(); // version
  }
}

function readEngineVersion(reader: BinaryReader): void {
  reader.readUInt16(); // major
  reader.readUInt16(); // minor
  reader.readUInt16(); // patch
  reader.readUInt32(); // changelist
  reader.readFString(); // branch
}

/** Parse FPackageFileSummary for UE 5.1 cooked packages (READING_COOKED_DATATABLES.md §3). */
export function readPackageSummary(buffer: Buffer): PackageFileSummary {
  return readPackageSummaryWithOffsets(buffer).summary;
}

export function readPackageSummaryWithOffsets(buffer: Buffer): ParsedPackageSummary {
  const reader = new BinaryReader(buffer);
  const tag = reader.readUInt32();
  if (tag !== PACKAGE_FILE_TAG) {
    throw new Error(`Invalid package tag: 0x${tag.toString(16)}`);
  }

  const legacyFileVersion = reader.readInt32();
  if (legacyFileVersion > -8) {
    throw new Error(`Unsupported legacy file version: ${legacyFileVersion}`);
  }

  let fileVersionUE4 = 0;
  let fileVersionUE5 = 0;
  if (legacyFileVersion !== -4) {
    reader.readInt32(); // FileVersionUE3 (unused in UE5)
  }
  fileVersionUE4 = reader.readInt32();
  if (legacyFileVersion <= -8) {
    fileVersionUE5 = reader.readInt32();
  }
  const fileVersionLicenseeUE = reader.readInt32();

  const useGameVersion =
    fileVersionUE4 === 0 && fileVersionUE5 === 0 && fileVersionLicenseeUE === 0;
  const verUE4 = useGameVersion ? UE5_1.fileVersionUE4 : fileVersionUE4;
  const verUE5 = useGameVersion ? UE5_1.fileVersionUE5 : fileVersionUE5;

  let totalHeaderSize = 0;
  let totalHeaderSizeOffset = -1;
  const hasSavedHashOnDisk = !useGameVersion && verUE5 >= UE5_VER.PACKAGE_SAVED_HASH;
  if (hasSavedHashOnDisk) {
    reader.readBytes(20); // FSHAHash
    totalHeaderSizeOffset = reader.offset;
    totalHeaderSize = reader.readInt32();
  }
  readCustomVersionContainer(reader);
  if (totalHeaderSize === 0) {
    totalHeaderSizeOffset = reader.offset;
    totalHeaderSize = reader.readInt32();
  }

  const packageName = reader.readFString();
  let packageFlags = reader.readUInt32();
  if (useGameVersion && (packageFlags & PKG.Cooked) === 0 && (packageFlags >>> 8) & PKG.Cooked) {
    packageFlags >>>= 8;
  }

  const nameCountOffset = reader.offset;
  const nameCount = reader.readInt32();
  const nameOffsetOffset = reader.offset;
  const nameOffset = reader.readInt32();

  let softObjectPathsCount = 0;
  let softObjectPathsOffset = 0;
  let softObjectPathsOffsetOffset: number | undefined;
  if (verUE5 >= UE5_VER.ADD_SOFTOBJECTPATH_LIST) {
    softObjectPathsCount = reader.readInt32();
    softObjectPathsOffsetOffset = reader.offset;
    softObjectPathsOffset = reader.readInt32();
  }

  const gatherableTextDataCount = reader.readInt32();
  const gatherableTextDataOffsetOffset = reader.offset;
  const gatherableTextDataOffset = reader.readInt32();

  const exportCount = reader.readInt32();
  const exportOffsetOffset = reader.offset;
  const exportOffset = reader.readInt32();
  const importCount = reader.readInt32();
  const importOffsetOffset = reader.offset;
  const importOffset = reader.readInt32();

  const dependsOffsetOffset = reader.offset;
  const dependsOffset = reader.readInt32();

  let softPackageReferencesCount = 0;
  let softPackageReferencesOffset = 0;
  let softPackageReferencesOffsetOffset: number | undefined;
  if (verUE4 >= UE4_VER.OLDEST_LOADABLE_PACKAGE) {
    softPackageReferencesCount = reader.readInt32();
    softPackageReferencesOffsetOffset = reader.offset;
    softPackageReferencesOffset = reader.readInt32();
  }

  let searchableNamesOffset = 0;
  let searchableNamesOffsetOffset: number | undefined;
  if (verUE4 >= UE4_VER.ADDED_SEARCHABLE_NAMES) {
    searchableNamesOffsetOffset = reader.offset;
    searchableNamesOffset = reader.readInt32();
  }

  const thumbnailTableOffsetOffset = reader.offset;
  const thumbnailTableOffset = reader.readInt32();

  let importTypeHierarchiesCount = 0;
  let importTypeHierarchiesOffset = 0;
  let importTypeHierarchiesOffsetOffset: number | undefined;
  if (!useGameVersion && verUE5 >= 1007) {
    importTypeHierarchiesCount = reader.readInt32();
    importTypeHierarchiesOffsetOffset = reader.offset;
    importTypeHierarchiesOffset = reader.readInt32();
  }

  if (useGameVersion || verUE5 < UE5_VER.REMOVE_OBJECT_EXPORT_PACKAGE_GUID) {
    reader.readBytes(16); // Guid
  }

  const generationCount = reader.readInt32();
  for (let i = 0; i < generationCount; i++) {
    reader.readInt32();
    reader.readInt32();
  }

  readEngineVersion(reader);
  readEngineVersion(reader);

  reader.readUInt32(); // CompressionFlags
  const compressedChunkCount = reader.readInt32();
  for (let i = 0; i < compressedChunkCount; i++) {
    reader.readInt32();
    reader.readInt32();
  }

  reader.readInt32(); // PackageSource

  const additionalPackagesCount = reader.readInt32();
  for (let i = 0; i < additionalPackagesCount; i++) {
    reader.readFString();
  }

  const assetRegistryDataOffsetOffset = reader.offset;
  reader.readInt32(); // AssetRegistryDataOffset
  const bulkDataStartOffsetOffset = reader.offset;
  const bulkDataStartOffset = reader.readInt64();

  const worldTileInfoDataOffsetOffset = reader.offset;
  reader.readInt32(); // WorldTileInfoDataOffset

  const chunkIdCount = reader.readInt32();
  for (let i = 0; i < chunkIdCount; i++) reader.readInt32();

  let preloadDependencyCount = -1;
  let preloadDependencyOffset = 0;
  let preloadDependencyOffsetOffset: number | undefined;
  if (verUE4 >= UE4_VER.PRELOAD_DEPENDENCIES_IN_COOKED_EXPORTS) {
    preloadDependencyCount = reader.readInt32();
    preloadDependencyOffsetOffset = reader.offset;
    preloadDependencyOffset = reader.readInt32();
  }

  let namesReferencedFromExportDataCountOffset: number | undefined;
  if (verUE5 >= UE5_VER.NAMES_REFERENCED_FROM_EXPORT_DATA) {
    namesReferencedFromExportDataCountOffset = reader.offset;
    reader.readInt32();
  } else if (reader.offset < nameOffset) {
    // JJK UE 5.1 (fileVersionUE5 1012): trailer int32 before name map.
    namesReferencedFromExportDataCountOffset = reader.offset;
    reader.readInt32();
    while (reader.offset < nameOffset) {
      reader.readInt32();
    }
  }
  let payloadTocOffsetOffset: number | undefined;
  if (verUE5 >= UE5_VER.PAYLOAD_TOC) {
    payloadTocOffsetOffset = reader.offset;
    reader.readInt64();
  }
  let dataResourceOffsetOffset: number | undefined;
  if (!useGameVersion && verUE5 >= UE5_VER.DATA_RESOURCES) {
    dataResourceOffsetOffset = reader.offset;
    reader.readInt32();
  }

  const summary: PackageFileSummary = {
    tag,
    legacyFileVersion,
    fileVersionUE4,
    fileVersionUE5,
    fileVersionLicenseeUE,
    packageFlags,
    totalHeaderSize,
    packageName,
    nameCount,
    nameOffset,
    softObjectPathsCount,
    softObjectPathsOffset,
    gatherableTextDataCount,
    gatherableTextDataOffset,
    exportCount,
    exportOffset,
    importCount,
    importOffset,
    dependsOffset,
    preloadDependencyCount,
    preloadDependencyOffset,
    bulkDataStartOffset,
    headerEndOffset: reader.offset,
    hasUnversionedProperties: (packageFlags & PKG.UnversionedProperties) !== 0,
    isCooked: (packageFlags & PKG.Cooked) !== 0,
  };

  const offsets: PackageSummaryOffsets = {
    totalHeaderSize: totalHeaderSizeOffset,
    nameCount: nameCountOffset,
    nameOffset: nameOffsetOffset,
    softObjectPathsOffset: softObjectPathsOffsetOffset,
    gatherableTextDataOffset: gatherableTextDataOffsetOffset,
    exportOffset: exportOffsetOffset,
    importOffset: importOffsetOffset,
    dependsOffset: dependsOffsetOffset,
    softPackageReferencesOffset: softPackageReferencesOffsetOffset,
    searchableNamesOffset: searchableNamesOffsetOffset,
    thumbnailTableOffset: thumbnailTableOffsetOffset,
    importTypeHierarchiesOffset: importTypeHierarchiesOffsetOffset,
    assetRegistryDataOffset: assetRegistryDataOffsetOffset,
    bulkDataStartOffset: bulkDataStartOffsetOffset,
    worldTileInfoDataOffset: worldTileInfoDataOffsetOffset,
    preloadDependencyOffset: preloadDependencyOffsetOffset,
    namesReferencedFromExportDataCount: namesReferencedFromExportDataCountOffset,
    payloadTocOffset: payloadTocOffsetOffset,
    dataResourceOffset: dataResourceOffsetOffset,
  };

  return { summary, offsets };
}
