/**
 * Cooked Blueprint parameter codec (JJK CC, UE 5.1, unversioned properties).
 *
 * Wire rules (reverse-engineered from the 5 `GameWidget*Parameter_BP` assets,
 * verified by byte-identical round-trip — see `scripts/` test):
 *
 * - Struct bodies (CDO top level, map values, array elements): standard
 *   FUnversionedHeader + delta values.
 * - `MapProperty`: `[int32 zero][int32 count][key,value pairs]`. The leading
 *   zero word is always 0 in base assets and is preserved on write.
 * - Map keys are 8-byte FNames even when the usmap inner type is
 *   `EnumProperty` (the name map holds full `EType::Value` labels).
 * - `ArrayProperty`/`SetProperty`: `[int32 count][elements]`; elements of
 *   UStruct type carry their own unversioned header each.
 * - `Vector`/`Vector2D`/…: native LWC doubles (FReal), no header.
 *
 * This codec is intentionally separate from `datatable/` + `unversioned/`:
 * cooked DataTables use a different map/array encoding, and the handoff
 * forbids touching datatable handling.
 */
import {
  BinaryReader,
  BinaryWriter,
  parseFNameText,
} from "../io/binary.js";
import type { SchemaRegistry, UsmapProperty, UsmapSchema } from "../schema/usmap.js";
import { buildZeroMask, readUnversionedHeader, writeUnversionedHeader, zeroMaskBit } from "../unversioned/header.js";
import {
  defaultPropertyAlignment,
  isSignedIntegerProperty,
  readUnversionedInteger,
  writeUnversionedInteger,
} from "../unversioned/integerWidth.js";
import {
  defaultNativeStructJson,
  isNativeStructZero,
  linearColorToHex,
} from "../unversioned/nativeStructJson.js";
import { isEmptyFText, readFText, writeFText } from "../unversioned/ftext.js";

export type BpJsonValue =
  | null
  | boolean
  | number
  | string
  | BpJsonValue[]
  | { [key: string]: BpJsonValue };

export interface BpContext {
  readonly names: readonly string[];
  readonly registry: SchemaRegistry;
  /**
   * Sidecar recording, per parsed struct object, the property names that
   * were zero-bit (present, no value bytes) on the wire. The writer
   * reproduces these exactly; this is what keeps cooker byte quirks
   * (e.g. first-bool-emits-bytes vs last-bool-zero-bit inside SlateBrush)
   * stable without per-type special cases. Fresh (hand-built or cloned)
   * objects without an entry fall back to `shouldSaveAsZero`.
   */
  readonly zeroStates?: WeakMap<object, ReadonlySet<string>>;
}

/** Deep clone that propagates zero-state sidecars to the copies. */
export function cloneWithZeroStates<T>(value: T, zeroStates?: WeakMap<object, ReadonlySet<string>>): T {
  const out = structuredClone(value);
  if (zeroStates) {
    const stack: Array<[unknown, unknown]> = [[value, out]];
    while (stack.length > 0) {
      const [src, dst] = stack.pop()!;
      if (src && typeof src === "object") {
        const zs = zeroStates.get(src);
        if (zs && dst && typeof dst === "object") zeroStates.set(dst, zs);
      }
      if (src && dst && typeof src === "object" && typeof dst === "object") {
        if (Array.isArray(src) && Array.isArray(dst)) {
          for (let i = 0; i < src.length; i++) stack.push([src[i], (dst as unknown[])[i]]);
        } else if (!Array.isArray(src) && !Array.isArray(dst)) {
          for (const k of Object.keys(src)) {
            stack.push([
              (src as Record<string, unknown>)[k],
              (dst as Record<string, unknown>)[k],
            ]);
          }
        }
      }
    }
  }
  return out;
}

export const NATIVE_STRUCTS: ReadonlySet<string> = new Set([
  "Vector",
  "Vector2D",
  "Vector4",
  "Rotator",
  "Color",
  "LinearColor",
  "Guid",
  "IntPoint",
]);

function isNativeStructProp(prop: UsmapProperty): boolean {
  return prop.type === "StructProperty" && !!prop.structName && NATIVE_STRUCTS.has(prop.structName);
}

function readInteger(reader: BinaryReader, prop: UsmapProperty, asFloat = false): number {
  const align = defaultPropertyAlignment(prop);
  return readUnversionedInteger(reader, align, asFloat, isSignedIntegerProperty(prop));
}

function writeInteger(writer: BinaryWriter, prop: UsmapProperty, value: number, asFloat = false): void {
  const align = defaultPropertyAlignment(prop);
  writeUnversionedInteger(writer, align, value, asFloat, isSignedIntegerProperty(prop));
}

function readNativeStruct(reader: BinaryReader, structName: string): Record<string, BpJsonValue> {
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
    case "IntPoint":
      return { X: reader.readInt32(), Y: reader.readInt32() };
    default:
      throw new Error(`Unknown native struct: ${structName}`);
  }
}

function writeNativeStruct(writer: BinaryWriter, structName: string, value: Record<string, BpJsonValue>): void {
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
    case "IntPoint":
      writer.writeInt32(Number(value.X ?? 0));
      writer.writeInt32(Number(value.Y ?? 0));
      break;
    default:
      throw new Error(`Unknown native struct: ${structName}`);
  }
}

/** Map keys are FNames on the wire (NameProperty AND EnumProperty inner types). */
function readMapKey(reader: BinaryReader, inner: UsmapProperty, ctx: BpContext): string {
  if (inner.type === "NameProperty" || inner.type === "EnumProperty") {
    return reader.readFName(ctx.names).text;
  }
  const v = readValue(reader, inner, ctx);
  return String(v);
}

function writeMapKey(writer: BinaryWriter, inner: UsmapProperty, key: string, ctx: BpContext): void {
  if (inner.type === "NameProperty" || inner.type === "EnumProperty") {
    writer.writeFName(parseFNameText(ctx.names, key));
    return;
  }
  writeValue(writer, inner, key, ctx);
}

export function readValue(reader: BinaryReader, prop: UsmapProperty, ctx: BpContext): BpJsonValue {
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
      return readInteger(reader, prop);
    case "FloatProperty":
    case "DoubleProperty":
      return readInteger(reader, prop, true);
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
      const align = defaultPropertyAlignment(prop);
      const raw = readUnversionedInteger(reader, align, false, isSignedIntegerProperty(prop));
      if (prop.enumName) {
        const label = ctx.registry.enumWireToName(prop.enumName, raw);
        if (label) return label;
      }
      return raw;
    }
    case "ArrayProperty":
    case "SetProperty": {
      const count = reader.readInt32();
      const inner = prop.innerType;
      if (!inner) return [];
      const arr: BpJsonValue[] = [];
      for (let i = 0; i < count; i++) {
        arr.push(readValue(reader, inner, ctx));
      }
      return arr;
    }
    case "MapProperty": {
      void reader.readInt32(); // leading zero word (always 0 in base assets)
      const count = reader.readInt32();
      const obj: Record<string, BpJsonValue> = {};
      if (!prop.innerType || !prop.valueType) return obj;
      for (let i = 0; i < count; i++) {
        const key = readMapKey(reader, prop.innerType, ctx);
        obj[key] = readValue(reader, prop.valueType, ctx);
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
      throw new Error(`Unsupported property type for BP read: ${prop.type} (${prop.name})`);
  }
}

function writeValue(writer: BinaryWriter, prop: UsmapProperty, value: BpJsonValue, ctx: BpContext): void {
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
      writeInteger(writer, prop, Number(value));
      break;
    case "FloatProperty":
    case "DoubleProperty":
      writeInteger(writer, prop, Number(value), true);
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
      writeInteger(writer, prop, raw);
      break;
    }
    case "ArrayProperty":
    case "SetProperty": {
      const arr = Array.isArray(value) ? value : [];
      writer.writeInt32(arr.length);
      if (prop.innerType) {
        for (const item of arr) writeValue(writer, prop.innerType, item, ctx);
      }
      break;
    }
    case "MapProperty": {
      const entries =
        value && typeof value === "object" && !Array.isArray(value)
          ? Object.entries(value as Record<string, BpJsonValue>)
          : [];
      writer.writeInt32(0); // leading zero word
      writer.writeInt32(entries.length);
      if (prop.innerType && prop.valueType) {
        for (const [k, v] of entries) {
          writeMapKey(writer, prop.innerType, k, ctx);
          writeValue(writer, prop.valueType, v, ctx);
        }
      }
      break;
    }
    case "StructProperty": {
      if (prop.structName && NATIVE_STRUCTS.has(prop.structName)) {
        writeNativeStruct(writer, prop.structName, (value as Record<string, BpJsonValue>) ?? {});
        break;
      }
      const schema = prop.structName ? ctx.registry.getFlattenedSchema(prop.structName) : undefined;
      if (!schema) throw new Error(`Missing struct schema: ${prop.structName ?? "unknown"}`);
      writeStruct(writer, schema, (value as Record<string, BpJsonValue>) ?? {}, ctx);
      break;
    }
    case "TextProperty":
      writeFText(writer, value);
      break;
    default:
      throw new Error(`Unsupported property type for BP write: ${prop.type} (${prop.name})`);
  }
}

function enumWireFromValue(prop: UsmapProperty, value: BpJsonValue, ctx: BpContext): number {
  if (typeof value === "number") return value;
  if (prop.enumName) return ctx.registry.enumNameToWire(prop.enumName, String(value)) ?? 0;
  return Number(value) || 0;
}

function shouldSaveAsZero(prop: UsmapProperty, value: BpJsonValue, ctx: BpContext): boolean {
  switch (prop.type) {
    case "BoolProperty":
      // Present bools always emit their byte (even false).
      return false;
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
      return Array.isArray(value) ? value.length === 0 : true;
    case "MapProperty":
      // Empty maps still serialize as [zero][count] bytes (never zero-bit).
      return false;
    case "StructProperty":
      if (value === 0) return true;
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        const v = value as Record<string, unknown>;
        // LinearColor zero-state is equality with the type default
        // {0,0,0,1}: Outline {0,0,0,1} is zero-bit, EmptyGauge {0,0,0,0.5}
        // serializes (both verified against base assets).
        if (prop.structName === "LinearColor") {
          const num = (x: unknown) => Number(x ?? 0);
          return num(v.R) === 0 && num(v.G) === 0 && num(v.B) === 0 && num(v.A) === 1;
        }
        // Headerful custom structs (Margin, SlateColor, Game* params, …)
        // always serialize (even when all-default); only native structs
        // and the numeric-zero `0` sentinel use the zero bit.
        if (prop.structName && !NATIVE_STRUCTS.has(prop.structName)) return false;
        return isNativeStructZero(prop.structName, v);
      }
      return true;
    default:
      return false;
  }
}

function defaultJsonValue(prop: UsmapProperty): BpJsonValue {
  if (prop.structName && NATIVE_STRUCTS.has(prop.structName)) {
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

function isDefaultValue(prop: UsmapProperty, value: BpJsonValue | undefined, ctx: BpContext): boolean {
  if (value === undefined || value === null) return true;
  if (prop.type === "StructProperty" && prop.structName && NATIVE_STRUCTS.has(prop.structName)) {
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      return isNativeStructZero(prop.structName, value as Record<string, unknown>);
    }
    return true;
  }
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
      return Array.isArray(value) ? value.length === 0 : true;
    case "MapProperty":
      return value && typeof value === "object" && !Array.isArray(value)
        ? Object.keys(value).length === 0
        : true;
    case "EnumProperty":
      return enumWireFromValue(prop, value, ctx) === 0;
    case "StructProperty":
      if (value === 0) return true;
      return false;
    default:
      return false;
  }
}

export function readStruct(
  reader: BinaryReader,
  schema: UsmapSchema,
  ctx: BpContext,
): Record<string, BpJsonValue> {
  const header = readUnversionedHeader(reader);
  const valuesReader = reader.clone();
  const result: Record<string, BpJsonValue> = {};
  const zeroProps = ctx.zeroStates ? new Set<string>() : undefined;
  let propIndex = 0;
  let zeroBit = 0;

  for (const fragment of header.fragments) {
    propIndex += fragment.skipNum;
    for (let i = 0; i < fragment.valueCount; i++) {
      const prop = schema.properties[propIndex];
      if (!prop) break;
      const isNonZero = fragment.hasZeroes ? !zeroMaskBit(header.zeroMask, zeroBit++) : true;
      result[prop.name] = isNonZero ? readValue(valuesReader, prop, ctx) : defaultJsonValue(prop);
      if (!isNonZero) zeroProps?.add(prop.name);
      propIndex++;
    }
  }
  if (ctx.zeroStates && zeroProps) ctx.zeroStates.set(result, zeroProps);

  // NOTE: properties absent from the fragment stay absent from the model
  // (no default-filling). The writer persists exactly the present key set,
  // which keeps base-asset bytes stable across patch round-trips.
  reader.seek(valuesReader.offset);
  return result;
}

const FRAGMENT_VALUE_MAX = 127;
const FRAGMENT_SKIP_MAX = 127;

/** Delta encoding: skip default-valued properties (matches cooked BP assets). */
export function writeStruct(
  writer: BinaryWriter,
  schema: UsmapSchema,
  values: Record<string, BpJsonValue>,
  ctx: BpContext,
): void {
  type Entry = { prop: UsmapProperty; value: BpJsonValue; isZero: boolean };
  type Fragment = { skipNum: number; hasZeroes: boolean; isLast: boolean; valueCount: number; items: Entry[] };

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

  // Presence encoding: persist exactly the key set present in the value
  // object (reads never default-fill). Present-but-zero values go in the
  // zero mask with no value bytes; absent middle props become fragment
  // skips; absent trailing props are truncated. Added map pairs/rows never
  // change the prop set, so base bytes round-trip exactly.
  const tracked = ctx.zeroStates?.get(values);
  for (const prop of schema.properties) {
    if (Object.prototype.hasOwnProperty.call(values, prop.name)) {
      const value = values[prop.name] ?? defaultJsonValue(prop);
      // Parsed zero-states reproduce exactly; fresh objects use type rules.
      const isZero = tracked ? tracked.has(prop.name) : shouldSaveAsZero(prop, value, ctx);
      includeProperty({ prop, value, isZero });
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
      writeValue(valuesWriter, item.prop, item.value, ctx);
    }
  }
  writer.writeBytes(valuesWriter.toBuffer());
}

/** JSON-safe deep clone for donor struct values. */
export function deepClone<T>(value: T): T {
  return structuredClone(value);
}
