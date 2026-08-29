import {
  BinaryReader,
  BinaryWriter,
  fNameComparisonIndexString,
  formatFNameText,
  parseFNameText,
} from "../io/binary.js";
import type { SchemaRegistry, UsmapProperty, UsmapSchema } from "../schema/usmap.js";
import { buildZeroMask, readUnversionedHeader, writeUnversionedHeader, zeroMaskBit } from "./header.js";
import {
  defaultPropertyAlignment,
  isSignedIntegerProperty,
  readUnversionedInteger,
  usesUnversionedIntegerSerialization,
  writeUnversionedInteger,
} from "./integerWidth.js";
import { getStructPropertyAlign } from "./structPropertyAlign.generated.js";
import {
  defaultNativeStructJson,
  isNativeStructZero,
  linearColorToHex,
} from "./nativeStructJson.js";
import { isEmptyFText, readFText, writeFText } from "./ftext.js";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface SerializeContext {
  readonly names: readonly string[];
  readonly registry: SchemaRegistry;
}

interface ReadPropertyOptions {
  /** When reading a TArray/TSet element, container field align from struct layout (Abrams offsetof). */
  readonly arrayContainerAlign?: number;
}

/** UE expands enum/byte array elements to container alignment slots; floats stay 4-byte. */
function arrayInnerIntegerAlign(inner: UsmapProperty, containerAlign?: number): number | undefined {
  if (containerAlign === undefined) return undefined;
  if (inner.type === "EnumProperty" || inner.type === "ByteProperty") return containerAlign;
  return undefined;
}

function enumByteUnderlying(prop: UsmapProperty): boolean {
  return (
    prop.type === "EnumProperty" &&
    (prop.innerType?.type === "ByteProperty" || prop.innerType?.type === "Int8Property")
  );
}

/** UEnum wire value from serialized integer (byte enums in 8-byte slots keep value in low byte). */
function enumArrayElementAsFName(prop: UsmapProperty, options?: ReadPropertyOptions): boolean {
  return prop.type === "EnumProperty" && (options?.arrayContainerAlign ?? 0) >= 8;
}

/** UEnum wire value from serialized integer (byte enums in 8-byte slots keep value in low byte). */
function enumWireValue(prop: UsmapProperty, raw: number, align: number): number {
  if (enumByteUnderlying(prop) && align >= 8) return raw & 0xff;
  return raw;
}

function readInteger(
  reader: BinaryReader,
  prop: UsmapProperty,
  options?: ReadPropertyOptions,
  asFloat = false,
): number {
  const align = integerAlign(prop, options);
  return readUnversionedInteger(reader, align, asFloat, isSignedIntegerProperty(prop));
}

function writeInteger(
  writer: BinaryWriter,
  prop: UsmapProperty,
  value: number,
  options?: ReadPropertyOptions,
  asFloat = false,
): void {
  const align = integerAlign(prop, options);
  writeUnversionedInteger(writer, align, value, asFloat, isSignedIntegerProperty(prop));
}
function integerAlign(prop: UsmapProperty, options?: ReadPropertyOptions): number {
  if (options?.arrayContainerAlign !== undefined && usesUnversionedIntegerSerialization(prop)) {
    return options.arrayContainerAlign;
  }
  return defaultPropertyAlignment(prop);
}

function arrayContainerAlign(structName: string, prop: UsmapProperty): number | undefined {
  const fromSchema = getStructPropertyAlign(structName, prop.name);
  if (fromSchema !== undefined) return fromSchema;
  return defaultPropertyAlignment(prop);
}

function nameIndex(names: readonly string[], text: string): number {
  return parseFNameText(names, text).index;
}

function isDefaultValue(prop: UsmapProperty, value: JsonValue | undefined): boolean {
  if (value === undefined || value === null) return true;
  switch (prop.type) {
    case "BoolProperty":
      return value === false;
    case "IntProperty":
    case "Int8Property":
    case "Int16Property":
    case "Int64Property":
    case "UInt16Property":
    case "UInt32Property":
    case "UInt64Property":
    case "ByteProperty":
      return value === 0;
    case "FloatProperty":
    case "DoubleProperty":
      return value === 0;
    case "NameProperty":
      return value === "None" || value === "";
    case "StrProperty":
      return value === "";
    case "TextProperty":
      return isEmptyFText(value);
    case "ObjectProperty":
    case "SoftObjectProperty":
    case "WeakObjectProperty":
    case "LazyObjectProperty":
    case "AssetObjectProperty":
      return value === "None" || value === null || value === 0;
    case "ArrayProperty":
    case "SetProperty":
    case "MapProperty":
      return Array.isArray(value) ? value.length === 0 : true;
    case "EnumProperty":
      return value === 0 || value === "0" || value === "";
    case "StructProperty":
      if (value === 0) return true;
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        return isNativeStructZero(prop.structName, value as Record<string, unknown>);
      }
      return true;
    default:
      return false;
  }
}

function readNativeStruct(reader: BinaryReader, structName: string): Record<string, JsonValue> {
  switch (structName) {
    case "Vector":
      return { X: reader.readFReal(), Y: reader.readFReal(), Z: reader.readFReal() };
    case "Rotator": {
      const pitch = reader.readFReal();
      const yaw = reader.readFReal();
      const roll = reader.readFReal();
      return { Pitch: pitch, Yaw: yaw, Roll: roll };
    }
    case "Vector2D":
      return { X: reader.readFReal(), Y: reader.readFReal() };
    case "Vector4":
      return { X: reader.readFReal(), Y: reader.readFReal(), Z: reader.readFReal(), W: reader.readFReal() };
    case "Color":
      return { B: reader.readUInt8(), G: reader.readUInt8(), R: reader.readUInt8(), A: reader.readUInt8() };
    case "LinearColor": {
      const R = reader.readFloat();
      const G = reader.readFloat();
      const B = reader.readFloat();
      const A = reader.readFloat();
      return { R, G, B, A, Hex: linearColorToHex(R, G, B) };
    }
    case "Guid":
      return { $bytes: reader.readBytes(16).toString("hex") };
    default:
      throw new Error(`Unknown native struct serialization: ${structName}`);
  }
}

function writeNativeStruct(writer: BinaryWriter, structName: string, value: Record<string, JsonValue>): void {
  switch (structName) {
    case "Vector":
      writer.writeFReal(Number(value.X ?? 0));
      writer.writeFReal(Number(value.Y ?? 0));
      writer.writeFReal(Number(value.Z ?? 0));
      break;
    case "Rotator":
      writer.writeFReal(Number(value.Pitch ?? value.X ?? 0));
      writer.writeFReal(Number(value.Yaw ?? value.Y ?? 0));
      writer.writeFReal(Number(value.Roll ?? value.Z ?? 0));
      break;
    case "Vector2D":
      writer.writeFReal(Number(value.X ?? 0));
      writer.writeFReal(Number(value.Y ?? 0));
      break;
    case "Vector4":
      writer.writeFReal(Number(value.X ?? 0));
      writer.writeFReal(Number(value.Y ?? 0));
      writer.writeFReal(Number(value.Z ?? 0));
      writer.writeFReal(Number(value.W ?? 0));
      break;
    case "Color":
      writer.writeUInt8(Number(value.B ?? 0));
      writer.writeUInt8(Number(value.G ?? 0));
      writer.writeUInt8(Number(value.R ?? 0));
      writer.writeUInt8(Number(value.A ?? 255));
      break;
    case "LinearColor":
      writer.writeFloat(Number(value.R ?? 0));
      writer.writeFloat(Number(value.G ?? 0));
      writer.writeFloat(Number(value.B ?? 0));
      writer.writeFloat(Number(value.A ?? 1));
      break;
    default:
      throw new Error(`Unknown native struct serialization: ${structName}`);
  }
}

const NATIVE_STRUCTS = new Set([
  "Vector",
  "Vector2D",
  "Vector4",
  "Rotator",
  "Color",
  "LinearColor",
  "Guid",
]);

function collectFNameFromProperty(
  prop: UsmapProperty,
  value: JsonValue | undefined,
  structName: string,
  names: readonly string[],
  registry: SchemaRegistry,
  out: Set<string>,
): void {
  if (value === undefined || value === null) return;

  switch (prop.type) {
    case "NameProperty": {
      const entry = fNameComparisonIndexString(names, String(value));
      if (entry) out.add(entry);
      break;
    }
    case "ArrayProperty":
    case "SetProperty": {
      if (!Array.isArray(value) || !prop.innerType) break;
      const innerAlign = arrayInnerIntegerAlign(prop.innerType, arrayContainerAlign(structName, prop));
      const innerOpts: ReadPropertyOptions | undefined =
        innerAlign !== undefined ? { arrayContainerAlign: innerAlign } : undefined;
      if (enumArrayElementAsFName(prop.innerType, innerOpts)) {
        for (const item of value) {
          const entry = fNameComparisonIndexString(names, String(item));
          if (entry) out.add(entry);
        }
      } else {
        for (const item of value) {
          collectFNameFromProperty(prop.innerType, item, structName, names, registry, out);
        }
      }
      break;
    }
    case "MapProperty": {
      if (!value || typeof value !== "object" || Array.isArray(value)) break;
      for (const [k, v] of Object.entries(value as Record<string, JsonValue>)) {
        if (prop.innerType) collectFNameFromProperty(prop.innerType, k, structName, names, registry, out);
        if (prop.valueType) collectFNameFromProperty(prop.valueType, v, structName, names, registry, out);
      }
      break;
    }
    case "StructProperty": {
      if (prop.structName && NATIVE_STRUCTS.has(prop.structName)) break;
      if (typeof value !== "object" || value === null || Array.isArray(value)) break;
      const nested = prop.structName ? registry.getFlattenedSchema(prop.structName) : undefined;
      if (nested) collectRequiredFNameStringsInto(nested, value as Record<string, JsonValue>, names, registry, out);
      break;
    }
    default:
      break;
  }
}

function collectRequiredFNameStringsInto(
  schema: UsmapSchema,
  values: Record<string, JsonValue>,
  names: readonly string[],
  registry: SchemaRegistry,
  out: Set<string>,
): void {
  for (const prop of schema.properties) {
    collectFNameFromProperty(prop, values[prop.name], schema.name, names, registry, out);
  }
}

/** Walk row struct values and collect FName comparison strings missing from the package name map. */
export function collectRequiredFNameStrings(
  schema: UsmapSchema,
  values: Record<string, JsonValue>,
  names: readonly string[],
  registry: SchemaRegistry,
): readonly string[] {
  const out = new Set<string>();
  collectRequiredFNameStringsInto(schema, values, names, registry, out);
  return [...out];
}

export function readPropertyValue(
  reader: BinaryReader,
  prop: UsmapProperty,
  ctx: SerializeContext,
  options?: ReadPropertyOptions,
): JsonValue {
  switch (prop.type) {
    case "BoolProperty":
      return reader.readUInt8() !== 0;
    case "IntProperty":
    case "Int8Property":
    case "Int16Property":
    case "Int64Property":
    case "UInt16Property":
    case "UInt32Property":
    case "UInt64Property":
    case "ByteProperty":
      return readInteger(reader, prop, options);
    case "FloatProperty":
      return readInteger(reader, prop, options, true);
    case "DoubleProperty":
      return readInteger(reader, prop, options, true);
    case "NameProperty":
      return reader.readFName(ctx.names).text;
    case "StrProperty":
      return reader.readFString();
    case "ObjectProperty":
    case "SoftObjectProperty":
    case "WeakObjectProperty":
    case "LazyObjectProperty":
    case "AssetObjectProperty":
      return reader.readPackageIndex();
    case "EnumProperty": {
      const align = integerAlign(prop, options);
      const raw = readUnversionedInteger(reader, align, false, isSignedIntegerProperty(prop));
      const wire = enumWireValue(prop, raw, align);
      if (prop.enumName) {
        const label = ctx.registry.enumWireToName(prop.enumName, wire);
        if (label) return label;
      }
      return wire;
    }
    case "ArrayProperty":
    case "SetProperty": {
      const count = reader.readInt32();
      const inner = prop.innerType;
      if (!inner) return [];
      const arr: JsonValue[] = [];
      const innerAlign = arrayInnerIntegerAlign(inner, options?.arrayContainerAlign);
      const innerOpts: ReadPropertyOptions | undefined =
        innerAlign !== undefined ? { arrayContainerAlign: innerAlign } : undefined;
      for (let i = 0; i < count; i++) {
        if (inner && enumArrayElementAsFName(inner, innerOpts)) {
          arr.push(reader.readFName(ctx.names).text);
        } else {
          arr.push(readPropertyValue(reader, inner!, ctx, innerOpts));
        }
      }
      return arr;
    }
    case "MapProperty": {
      const count = reader.readInt32();
      const obj: Record<string, JsonValue> = {};
      for (let i = 0; i < count; i++) {
        const key = prop.innerType ? String(readPropertyValue(reader, prop.innerType, ctx)) : String(i);
        const val = prop.valueType ? readPropertyValue(reader, prop.valueType, ctx) : null;
        obj[key] = val;
      }
      return obj;
    }
    case "StructProperty": {
      if (prop.structName && NATIVE_STRUCTS.has(prop.structName)) {
        return readNativeStruct(reader, prop.structName);
      }
      const schema = prop.structName ? ctx.registry.getFlattenedSchema(prop.structName) : undefined;
      if (!schema) throw new Error(`Missing struct schema: ${prop.structName ?? "unknown"}`);
      return readStruct(reader, schema, ctx);
    }
    case "TextProperty":
      return readFText(reader, ctx.names);
    default:
      throw new Error(`Unsupported property type for read: ${prop.type} (${prop.name})`);
  }
}

function writePropertyValue(
  writer: BinaryWriter,
  prop: UsmapProperty,
  value: JsonValue,
  ctx: SerializeContext,
  options?: ReadPropertyOptions,
): void {
  switch (prop.type) {
    case "BoolProperty":
      writer.writeUInt8(value ? 1 : 0);
      break;
    case "IntProperty":
    case "Int8Property":
    case "Int16Property":
    case "Int64Property":
    case "UInt16Property":
    case "UInt32Property":
    case "UInt64Property":
    case "ByteProperty":
      writeInteger(writer, prop, Number(value), options);
      break;
    case "FloatProperty":
      writeInteger(writer, prop, Number(value), options, true);
      break;
    case "DoubleProperty":
      writeInteger(writer, prop, Number(value), options, true);
      break;
    case "NameProperty":
      writer.writeFName(parseFNameText(ctx.names, String(value)));
      break;
    case "StrProperty":
      writer.writeFString(String(value));
      break;
    case "ObjectProperty":
    case "SoftObjectProperty":
    case "WeakObjectProperty":
    case "LazyObjectProperty":
    case "AssetObjectProperty":
      writer.writePackageIndex(typeof value === "number" ? value : 0);
      break;
    case "EnumProperty": {
      let raw = 0;
      if (typeof value === "number") raw = value;
      else if (prop.enumName) {
        raw = ctx.registry.enumNameToWire(prop.enumName, String(value)) ?? 0;
      }
      writeInteger(writer, prop, raw, options);
      break;
    }
    case "ArrayProperty":
    case "SetProperty": {
      const arr = Array.isArray(value) ? value : [];
      writer.writeInt32(arr.length);
      if (prop.innerType) {
        const innerAlign = arrayInnerIntegerAlign(prop.innerType, options?.arrayContainerAlign);
        const innerOpts: ReadPropertyOptions | undefined =
          innerAlign !== undefined ? { arrayContainerAlign: innerAlign } : undefined;
        for (const item of arr) {
          if (enumArrayElementAsFName(prop.innerType, innerOpts)) {
            writer.writeFName(parseFNameText(ctx.names, String(item)));
          } else {
            writePropertyValue(writer, prop.innerType, item, ctx, innerOpts);
          }
        }
      }
      break;
    }
    case "MapProperty": {
      const entries = value && typeof value === "object" && !Array.isArray(value)
        ? Object.entries(value as Record<string, JsonValue>)
        : [];
      writer.writeInt32(entries.length);
      for (const [k, v] of entries) {
        if (prop.innerType) writePropertyValue(writer, prop.innerType, k, ctx);
        if (prop.valueType) writePropertyValue(writer, prop.valueType, v, ctx);
      }
      break;
    }
    case "StructProperty": {
      if (prop.structName && NATIVE_STRUCTS.has(prop.structName)) {
        writeNativeStruct(writer, prop.structName, (value as Record<string, JsonValue>) ?? {});
        break;
      }
      const schema = prop.structName ? ctx.registry.getFlattenedSchema(prop.structName) : undefined;
      if (!schema) throw new Error(`Missing struct schema: ${prop.structName ?? "unknown"}`);
      writeStruct(writer, schema, (value as Record<string, JsonValue>) ?? {}, ctx);
      break;
    }
    case "TextProperty":
      writeFText(writer, value);
      break;
    default:
      throw new Error(`Unsupported property type for write: ${prop.type} (${prop.name})`);
  }
}

export interface WriteStructOptions {
  /** Dense: include every property (cooked row structs). Delta: skip defaults (UObject/DataTable export). */
  readonly mode?: "dense" | "delta";
}

const FRAGMENT_VALUE_MAX = 127;
const FRAGMENT_SKIP_MAX = 127;

function enumWireFromValue(prop: UsmapProperty, value: JsonValue, ctx: SerializeContext): number {
  if (typeof value === "number") return value;
  if (prop.enumName) return ctx.registry.enumNameToWire(prop.enumName, String(value)) ?? 0;
  return Number(value) || 0;
}

function shouldSaveAsZero(prop: UsmapProperty, value: JsonValue, ctx: SerializeContext): boolean {
  switch (prop.type) {
    case "BoolProperty":
      return value === false;
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
      return enumWireFromValue(prop, value, ctx) === 0;
    case "NameProperty":
      return value === "None" || value === "";
    case "StrProperty":
      return value === "";
    case "TextProperty":
      return isEmptyFText(value);
    case "ObjectProperty":
    case "SoftObjectProperty":
    case "WeakObjectProperty":
    case "LazyObjectProperty":
    case "AssetObjectProperty":
      return value === "None" || value === null || value === 0;
    case "ArrayProperty":
    case "SetProperty":
    case "MapProperty":
      return Array.isArray(value) ? value.length === 0 : true;
    case "StructProperty":
      if (value === 0) return true;
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        return isNativeStructZero(prop.structName, value as Record<string, unknown>);
      }
      return true;
    default:
      return false;
  }
}

function defaultJsonValue(prop: UsmapProperty): JsonValue {
  if (prop.type === "StructProperty" && prop.structName && NATIVE_STRUCTS.has(prop.structName)) {
    return defaultNativeStructJson(prop.structName);
  }
  switch (prop.type) {
    case "BoolProperty":
      return false;
    case "FloatProperty":
    case "DoubleProperty":
      return 0;
    case "NameProperty":
      return "None";
    case "StrProperty":
      return "";
    case "TextProperty":
      return { flags: 0, historyType: -1, text: "" };
    case "ArrayProperty":
    case "SetProperty":
      return [];
    case "MapProperty":
      return {};
    case "EnumProperty":
      return 0;
    default:
      return 0;
  }
}

export function readStruct(
  reader: BinaryReader,
  schema: UsmapSchema,
  ctx: SerializeContext,
): Record<string, JsonValue> {
  const header = readUnversionedHeader(reader);
  const valuesReader = reader.clone();
  const result: Record<string, JsonValue> = {};
  let propIndex = 0;
  let zeroBit = 0;

  // UE FUnversionedHeader::FIterator::IsNonZero — mask bit set means stored-as-zero (not in values stream).
  for (const fragment of header.fragments) {
    propIndex += fragment.skipNum;
    for (let i = 0; i < fragment.valueCount; i++) {
      const prop = schema.properties[propIndex];
      if (!prop) break;
      const isNonZero = fragment.hasZeroes ? !zeroMaskBit(header.zeroMask, zeroBit++) : true;
      const readOpts: ReadPropertyOptions | undefined =
        prop.type === "ArrayProperty" || prop.type === "SetProperty"
          ? { arrayContainerAlign: arrayContainerAlign(schema.name, prop) }
          : undefined;
      result[prop.name] = isNonZero
        ? readPropertyValue(valuesReader, prop, ctx, readOpts)
        : defaultJsonValue(prop);
      propIndex++;
    }
  }

  for (; propIndex < schema.properties.length; propIndex++) {
    const prop = schema.properties[propIndex];
    if (!(prop.name in result)) result[prop.name] = defaultJsonValue(prop);
  }

  reader.seek(valuesReader.offset);
  return result;
}

export function writeStruct(
  writer: BinaryWriter,
  schema: UsmapSchema,
  values: Record<string, JsonValue>,
  ctx: SerializeContext,
  options: WriteStructOptions = {},
): void {
  const dense = (options.mode ?? "dense") === "dense";

  type Entry = { prop: UsmapProperty; value: JsonValue; isZero: boolean };
  type Fragment = {
    skipNum: number;
    hasZeroes: boolean;
    isLast: boolean;
    valueCount: number;
    items: Entry[];
  };

  const fragments: Fragment[] = [{ skipNum: 0, hasZeroes: false, isLast: false, valueCount: 0, items: [] }];
  const zeroMaskBits: boolean[] = [];

  const trimZeroMaskForFragment = (fragment: Fragment): void => {
    if (!fragment.hasZeroes && fragment.valueCount > 0) {
      zeroMaskBits.splice(zeroMaskBits.length - fragment.valueCount, fragment.valueCount);
    }
  };

  const includeProperty = (entry: Entry): void => {
    const last = fragments[fragments.length - 1];
    if (last.valueCount >= FRAGMENT_VALUE_MAX) {
      trimZeroMaskForFragment(last);
      fragments.push({ skipNum: 0, hasZeroes: false, isLast: false, valueCount: 0, items: [] });
    }
    const frag = fragments[fragments.length - 1];
    frag.valueCount++;
    frag.items.push(entry);
    frag.hasZeroes ||= entry.isZero;
    zeroMaskBits.push(entry.isZero);
  };

  const excludeProperty = (): void => {
    const last = fragments[fragments.length - 1];
    if (last.valueCount > 0 || last.skipNum >= FRAGMENT_SKIP_MAX) {
      trimZeroMaskForFragment(last);
      fragments.push({ skipNum: 0, hasZeroes: false, isLast: false, valueCount: 0, items: [] });
    }
    fragments[fragments.length - 1].skipNum++;
  };

  for (const prop of schema.properties) {
    const value = values[prop.name] ?? defaultJsonValue(prop);
    const include = dense || !isDefaultValue(prop, value);
    if (include) {
      includeProperty({
        prop,
        value,
        isZero: shouldSaveAsZero(prop, value, ctx),
      });
    } else {
      excludeProperty();
    }
  }

  if (fragments.length > 0) {
    trimZeroMaskForFragment(fragments[fragments.length - 1]);
  }

  while (fragments.length > 1 && fragments[fragments.length - 1].valueCount === 0) {
    fragments.pop();
  }

  if (fragments.length === 0) {
    fragments.push({ skipNum: 0, hasZeroes: false, isLast: true, valueCount: 0, items: [] });
  }
  fragments[fragments.length - 1].isLast = true;

  writeUnversionedHeader(writer, {
    fragments: fragments.map((f) => ({
      skipNum: f.skipNum,
      hasZeroes: f.hasZeroes,
      isLast: f.isLast,
      valueCount: f.valueCount,
    })),
    zeroMask: buildZeroMask(zeroMaskBits),
  });

  const valuesWriter = new BinaryWriter();
  for (const fragment of fragments) {
    for (const item of fragment.items) {
      if (item.isZero) continue;
      const writeOpts: ReadPropertyOptions | undefined =
        item.prop.type === "ArrayProperty" || item.prop.type === "SetProperty"
          ? { arrayContainerAlign: arrayContainerAlign(schema.name, item.prop) }
          : undefined;
      writePropertyValue(valuesWriter, item.prop, item.value, ctx, writeOpts);
    }
  }
  writer.writeBytes(valuesWriter.toBuffer());
}
