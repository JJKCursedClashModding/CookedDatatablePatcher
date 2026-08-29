import { BinaryReader } from "../io/binary.js";
import { UE4_VER } from "./versions.js";

export interface ObjectImport {
  readonly classPackageIndex: number;
  readonly classNameIndex: number;
  readonly outerIndex: number;
  readonly objectNameIndex: number;
  readonly packageNameIndex: number;
}

export interface ObjectExport {
  readonly index: number;
  readonly classIndex: number;
  readonly superIndex: number;
  readonly templateIndex: number;
  readonly outerIndex: number;
  readonly objectNameIndex: number;
  readonly objectNameIndexFileOffset: number;
  readonly objectFlags: number;
  readonly serialSize: number;
  readonly serialSizeFileOffset: number;
  readonly serialOffset: number;
  readonly serialOffsetFileOffset: number;
  readonly notForClient: boolean;
  readonly isAsset: boolean;
}

function readFNameIndex(reader: BinaryReader): number {
  const index = reader.readInt32();
  reader.readInt32(); // number
  return index;
}

/** Name map at Summary.NameOffset (READING_COOKED_DATATABLES.md §4). */
export function readNameMap(buffer: Buffer, nameOffset: number, nameCount: number): string[] {
  const reader = new BinaryReader(buffer, nameOffset);
  const names: string[] = [];
  for (let i = 0; i < nameCount; i++) {
    names.push(reader.readFString());
    // NAME_HASHES_SERIALIZED: two uint16 hashes follow each entry in cooked packages.
    reader.readUInt16();
    reader.readUInt16();
  }
  return names;
}

export function readImportMap(buffer: Buffer, importOffset: number, importCount: number): ObjectImport[] {
  const reader = new BinaryReader(buffer, importOffset);
  const imports: ObjectImport[] = [];
  for (let i = 0; i < importCount; i++) {
    imports.push({
      classPackageIndex: readFNameIndex(reader),
      classNameIndex: readFNameIndex(reader),
      outerIndex: reader.readInt32(),
      objectNameIndex: readFNameIndex(reader),
      packageNameIndex: reader.readInt32(),
    });
  }
  return imports;
}

/** Export map at Summary.ExportOffset (READING_COOKED_DATATABLES.md §4.1). */
export function readExportMap(buffer: Buffer, exportOffset: number, exportCount: number): ObjectExport[] {
  const reader = new BinaryReader(buffer, exportOffset);
  const exports: ObjectExport[] = [];
  for (let i = 0; i < exportCount; i++) {
    const classIndex = reader.readInt32();
    const superIndex = reader.readInt32();
    const templateIndex = reader.readInt32();
    const outerIndex = reader.readInt32();
    const objectNameIndexFileOffset = reader.offset;
    const objectNameIndex = readFNameIndex(reader);
    const objectFlags = reader.readUInt32();
    const serialSizeFileOffset = reader.offset;
    const serialSize = Number(reader.readInt64());
    const serialOffsetFileOffset = reader.offset;
    const serialOffset = Number(reader.readInt64());
    reader.readUInt8(); // ForcedExport
    const notForClient = reader.readUInt8() !== 0;
    reader.readUInt8(); // NotForServer
    // UE5.1: PackageGuid omitted (REMOVE_OBJECT_EXPORT_PACKAGE_GUID)
    reader.readUInt8(); // IsInheritedInstance
    reader.readUInt32(); // PackageFlags
    reader.readUInt8(); // NotAlwaysLoadedForEditorGame
    const isAsset = reader.readUInt8() !== 0;
    reader.readUInt8(); // GeneratePublicHash

    if (UE4_VER.PRELOAD_DEPENDENCIES_IN_COOKED_EXPORTS) {
      reader.readInt32(); // FirstExportDependency
      reader.readInt32(); // SerializationBeforeSerializationDependencies
      reader.readInt32(); // CreateBeforeSerializationDependencies
      reader.readInt32(); // SerializationBeforeCreateDependencies
      reader.readInt32(); // CreateBeforeCreateDependencies
    }

    exports.push({
      index: i,
      classIndex,
      superIndex,
      templateIndex,
      outerIndex,
      objectNameIndex,
      objectNameIndexFileOffset,
      objectFlags,
      serialSize,
      serialSizeFileOffset,
      serialOffset,
      serialOffsetFileOffset,
      notForClient,
      isAsset,
    });
  }
  return exports;
}

export function resolveName(names: readonly string[], index: number): string {
  if (index < 0 || index >= names.length) return "None";
  return names[index] ?? "None";
}

export function resolvePackageIndex(index: number): { kind: "export" | "import" | "null"; idx: number } {
  if (index === 0) return { kind: "null", idx: 0 };
  if (index > 0) return { kind: "export", idx: index - 1 };
  return { kind: "import", idx: -index - 1 };
}
