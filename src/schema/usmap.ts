import { brotliDecompressSync } from "node:zlib";
import { BinaryReader } from "../io/binary.js";

export const USMAP_PROPERTY_TYPES = [
  "ByteProperty",
  "BoolProperty",
  "IntProperty",
  "FloatProperty",
  "ObjectProperty",
  "NameProperty",
  "DelegateProperty",
  "DoubleProperty",
  "ArrayProperty",
  "StructProperty",
  "StrProperty",
  "TextProperty",
  "InterfaceProperty",
  "MulticastDelegateProperty",
  "WeakObjectProperty",
  "LazyObjectProperty",
  "AssetObjectProperty",
  "SoftObjectProperty",
  "UInt64Property",
  "UInt32Property",
  "UInt16Property",
  "Int64Property",
  "Int16Property",
  "Int8Property",
  "MapProperty",
  "SetProperty",
  "EnumProperty",
  "FieldPathProperty",
  "OptionalProperty",
  "Utf8StrProperty",
  "AnsiStrProperty",
  "ClassProperty",
  "MulticastInlineDelegateProperty",
  "SoftClassProperty",
  "VerseStringProperty",
  "VerseDynamicProperty",
  "VerseFunctionProperty",
] as const;

export type UsmapPropertyType = (typeof USMAP_PROPERTY_TYPES)[number] | "Unknown";

export interface UsmapProperty {
  readonly name: string;
  readonly type: UsmapPropertyType;
  readonly arraySize: number;
  readonly structName?: string;
  readonly enumName?: string;
  readonly innerType?: UsmapProperty;
  readonly valueType?: UsmapProperty;
}

export interface UsmapSchema {
  readonly name: string;
  readonly superName: string;
  readonly properties: readonly UsmapProperty[];
}

export interface UsmapEnumMember {
  readonly value: number;
  readonly name: string;
}

export interface UsmapEnumDef {
  /** Member names sorted by wire value (usmap v4 explicit order). */
  readonly names: readonly string[];
  /** Wire value ↔ name (usmap v0–3: value = 0..n-1; v4: explicit UEnum values). */
  readonly members: readonly UsmapEnumMember[];
}

export interface UsmapMappings {
  readonly enums: Readonly<Record<string, UsmapEnumDef>>;
  readonly schemas: Readonly<Record<string, UsmapSchema>>;
}

const enum UsmapVersion {
  Initial = 0,
  PackageVersioning = 1,
  LongFName = 2,
  LargeEnums = 3,
  ExplicitEnumValues = 4,
}

const enum UsmapCompression {
  None = 0,
  Oodle = 1,
  Brotli = 2,
  Zstd = 3,
}

function readName(reader: BinaryReader, names: readonly string[]): string {
  const index = reader.readUInt32();
  return names[index] ?? `__NAME_${index}__`;
}

function readPropertyType(reader: BinaryReader, names: readonly string[]): UsmapProperty {
  const typeIndex = reader.readUInt8();
  const type: UsmapPropertyType =
    typeIndex === 0xfd || typeIndex === 0xfe || typeIndex === 0xff
      ? "Unknown"
      : (USMAP_PROPERTY_TYPES[typeIndex] ?? "Unknown");

  if (type === "EnumProperty") {
    const innerType = readPropertyType(reader, names);
    const enumName = readName(reader, names);
    return { name: "", type, arraySize: 1, innerType, enumName };
  }
  if (type === "StructProperty") {
    const structName = readName(reader, names);
    return { name: "", type, arraySize: 1, structName };
  }
  if (type === "ArrayProperty" || type === "SetProperty" || type === "OptionalProperty") {
    const innerType = readPropertyType(reader, names);
    return { name: "", type, arraySize: 1, innerType };
  }
  if (type === "MapProperty") {
    const innerType = readPropertyType(reader, names);
    const valueType = readPropertyType(reader, names);
    return { name: "", type, arraySize: 1, innerType, valueType };
  }
  return { name: "", type, arraySize: 1 };
}

function readPropertyInfo(reader: BinaryReader, names: readonly string[]): UsmapProperty {
  reader.readUInt16(); // schema index
  const arraySize = reader.readUInt8();
  const name = readName(reader, names);
  const typeInfo = readPropertyType(reader, names);
  return { ...typeInfo, name, arraySize };
}

function deserializeBody(reader: BinaryReader, version: number): UsmapMappings {
  const readNameLen = () => (version >= UsmapVersion.LongFName ? reader.readUInt16() : reader.readUInt8());
  const readEnumCount = () => (version >= UsmapVersion.LargeEnums ? reader.readUInt16() : reader.readUInt8());

  const namesSize = reader.readUInt32();
  const names: string[] = [];
  for (let i = 0; i < namesSize; i++) {
    const len = readNameLen();
    names.push(reader.readBytes(len).toString("utf8"));
  }

  const enums: Record<string, UsmapEnumDef> = {};
  const enumCount = reader.readUInt32();
  for (let i = 0; i < enumCount; i++) {
    const enumName = readName(reader, names);
    const memberCount = readEnumCount();
    const members: UsmapEnumMember[] = [];
    if (version >= UsmapVersion.ExplicitEnumValues) {
      for (let j = 0; j < memberCount; j++) {
        const value = Number(reader.readUInt64());
        members.push({ value, name: readName(reader, names) });
      }
      members.sort((a, b) => a.value - b.value);
    } else {
      for (let j = 0; j < memberCount; j++) {
        members.push({ value: j, name: readName(reader, names) });
      }
    }
    enums[enumName] = { names: members.map((m) => m.name), members };
  }

  const schemas: Record<string, UsmapSchema> = {};
  const schemaCount = reader.readUInt32();
  for (let i = 0; i < schemaCount; i++) {
    const schemaName = readName(reader, names);
    const superName = readName(reader, names);
    reader.readUInt16(); // propertyCount (includes non-serialized)
    const serializableCount = reader.readUInt16();
    const properties: UsmapProperty[] = [];
    for (let j = 0; j < serializableCount; j++) {
      properties.push(readPropertyInfo(reader, names));
    }
    schemas[schemaName] = { name: schemaName, superName, properties };
  }

  return { enums, schemas };
}

/** Parse .usmap (versions 0–4, CUE4Parse-compatible). */
export function parseUsmap(buffer: Buffer): UsmapMappings {
  const reader = new BinaryReader(buffer);
  const magic = reader.readUInt16();
  if (magic !== 0x30c4) throw new Error(`Invalid usmap magic: 0x${magic.toString(16)}`);

  const version = reader.readUInt8();
  if (version > UsmapVersion.ExplicitEnumValues) {
    throw new Error(`Unsupported usmap version: ${version}`);
  }

  if (version >= UsmapVersion.PackageVersioning) {
    const hasVersioning = version >= UsmapVersion.ExplicitEnumValues
      ? reader.readInt32() !== 0
      : reader.readUInt8() !== 0;
    if (hasVersioning) {
      reader.readInt32(); // UE4 package version
      reader.readInt32(); // UE5 package version
      const cvCount = reader.readInt32();
      for (let i = 0; i < cvCount; i++) {
        reader.readBytes(16);
        reader.readInt32();
      }
      reader.readUInt32(); // NetCL
    }
  }

  const compression = reader.readUInt8();
  const compressedSize = reader.readUInt32();
  const decompressedSize = reader.readUInt32();
  const compressed = reader.readBytes(compressedSize);

  let data: Buffer;
  switch (compression) {
    case UsmapCompression.None:
      if (compressedSize !== decompressedSize) {
        throw new Error("Uncompressed usmap size mismatch");
      }
      data = compressed;
      break;
    case UsmapCompression.Brotli:
      data = brotliDecompressSync(compressed);
      break;
    case UsmapCompression.Oodle:
      throw new Error("Oodle-compressed usmap is not supported");
    case UsmapCompression.Zstd:
      throw new Error("Zstd-compressed usmap is not supported (install zstd-napi to add support)");
    default:
      throw new Error(`Unknown usmap compression method: ${compression}`);
  }

  if (data.length !== decompressedSize) {
    throw new Error(`Usmap decompress size mismatch: got ${data.length}, expected ${decompressedSize}`);
  }

  return deserializeBody(new BinaryReader(data), version);
}

export class SchemaRegistry {
  constructor(private readonly mappings: UsmapMappings) {}

  getSchema(name: string): UsmapSchema | undefined {
    return this.mappings.schemas[name];
  }

  /** Full serializable property list (super chain first), as used by unversioned headers. */
  getFlattenedSchema(name: string): UsmapSchema | undefined {
    const chain: UsmapSchema[] = [];
    const seen = new Set<string>();
    let current = this.mappings.schemas[name];
    while (current && !seen.has(current.name)) {
      seen.add(current.name);
      chain.unshift(current);
      const superName = current.superName;
      if (!superName || superName === "None") break;
      current = this.mappings.schemas[superName];
    }
    if (chain.length === 0) return undefined;
    const properties = chain.flatMap((s) => s.properties);
    return { name, superName: chain[0]?.superName ?? "None", properties };
  }

  resolveRowStruct(tableBaseName: string): UsmapSchema | undefined {
    const candidates = [
      `GameDataTableRow_${tableBaseName}`,
      `F${tableBaseName}TableRow`,
      `${tableBaseName}TableRow`,
      tableBaseName,
    ];
    for (const candidate of candidates) {
      const schema = this.mappings.schemas[candidate];
      if (schema) return schema;
    }
    return undefined;
  }

  getEnum(name: string): readonly string[] | undefined {
    return this.mappings.enums[name]?.names;
  }

  getEnumDef(name: string): UsmapEnumDef | undefined {
    return this.mappings.enums[name];
  }

  /** Map on-disk enum wire value → member name (handles `Type::Name` labels on write). */
  enumWireToName(enumName: string, wire: number): string | undefined {
    const def = this.mappings.enums[enumName];
    if (!def) return undefined;
    const hit = def.members.find((m) => m.value === wire);
    return hit?.name;
  }

  /** Map editor / JSON enum label → on-disk wire value. */
  enumNameToWire(enumName: string, label: string): number | undefined {
    const def = this.mappings.enums[enumName];
    if (!def) return undefined;
    const short = label.includes("::") ? label.split("::").pop()! : label;
    const hit = def.members.find((m) => m.name === short || m.name === label);
    return hit?.value;
  }
}
