import { BinaryReader, BinaryWriter } from "../io/binary.js";
import type { UsmapProperty } from "../schema/usmap.js";

/** UE FUnversionedPropertySerializer::GetIntType — width from property min alignment. */
export function unversionedIntegerByteWidth(alignment: number): 1 | 2 | 4 | 8 {
  if (alignment >= 8) return 8;
  if (alignment >= 4) return 4;
  if (alignment >= 2) return 2;
  return 1;
}

/** Numeric / enum properties serialize as integers in unversioned mode (not FName/struct/array shell). */
export function usesUnversionedIntegerSerialization(prop: UsmapProperty): boolean {
  switch (prop.type) {
    case "IntProperty":
    case "Int8Property":
    case "Int16Property":
    case "Int64Property":
    case "UInt16Property":
    case "UInt32Property":
    case "UInt64Property":
    case "ByteProperty":
    case "FloatProperty":
    case "DoubleProperty":
    case "EnumProperty":
      return true;
    default:
      return false;
  }
}

export function defaultPropertyAlignment(prop: UsmapProperty): number {
  if (prop.type === "EnumProperty" && prop.innerType) {
    return defaultPropertyAlignment(prop.innerType);
  }
  switch (prop.type) {
    case "NameProperty":
      return 8;
    case "DoubleProperty":
    case "Int64Property":
    case "UInt64Property":
      return 8;
    case "IntProperty":
    case "UInt32Property":
    case "FloatProperty":
    case "ObjectProperty":
    case "SoftObjectProperty":
    case "WeakObjectProperty":
    case "LazyObjectProperty":
    case "AssetObjectProperty":
      return 4;
    case "Int16Property":
    case "UInt16Property":
      return 2;
    default:
      return 1;
  }
}

export function readUnversionedInteger(
  reader: BinaryReader,
  alignment: number,
  asFloat = false,
  signed = false,
): number {
  const w = unversionedIntegerByteWidth(alignment);
  switch (w) {
    case 1:
      return signed ? reader.readInt8() : reader.readUInt8();
    case 2:
      return signed ? reader.readInt16() : reader.readUInt16();
    case 4:
      return asFloat ? reader.readFloat() : signed ? reader.readInt32() : reader.readUInt32();
    case 8:
      if (asFloat) return reader.readDouble();
      return signed ? Number(reader.readInt64()) : Number(reader.readUInt64());
  }
}

export function writeUnversionedInteger(
  writer: BinaryWriter,
  alignment: number,
  value: number,
  asFloat = false,
  signed = false,
): void {
  const w = unversionedIntegerByteWidth(alignment);
  switch (w) {
    case 1:
      if (signed) writer.writeInt8(value);
      else writer.writeUInt8(value);
      break;
    case 2:
      if (signed) writer.writeInt16(value);
      else writer.writeUInt16(value);
      break;
    case 4:
      if (asFloat) writer.writeFloat(value);
      else if (signed) writer.writeInt32(value);
      else writer.writeUInt32(value);
      break;
    case 8:
      if (asFloat) writer.writeDouble(value);
      else if (signed) writer.writeInt64(value);
      else writer.writeUInt64(value);
      break;
  }
}

export function isSignedIntegerProperty(prop: { readonly type: string }): boolean {
  switch (prop.type) {
    case "IntProperty":
    case "Int8Property":
    case "Int16Property":
    case "Int64Property":
      return true;
    default:
      return false;
  }
}
