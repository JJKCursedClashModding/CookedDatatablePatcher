import { BinaryReader, BinaryWriter } from "../io/binary.js";

type JsonPrimitive = null | boolean | number | string;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

/** ETextFlag bits used in cooked packages. */
export const FTEXT_FLAG_CULTURE_INVARIANT = 1 << 1;

/** ETextHistoryType */
export const enum FTextHistoryType {
  None = -1,
  Base = 0,
  NamedFormat = 1,
  OrderedFormat = 2,
  ArgumentFormat = 3,
  AsNumber = 4,
  AsPercent = 5,
  AsCurrency = 6,
  AsDate = 7,
  AsTime = 8,
  AsDateTime = 9,
  Transform = 10,
  StringTableEntry = 11,
  TextGenerator = 12,
}

export interface FTextJson {
  readonly flags: number;
  readonly historyType: number;
  /** Display / culture-invariant string when HistoryType is None. */
  readonly cultureInvariantString?: string;
  readonly namespace?: string;
  readonly key?: string;
  readonly sourceString?: string;
}

export function isEmptyFText(value: JsonValue | undefined): boolean {
  if (value === undefined || value === null || value === "") return true;
  if (typeof value === "string") return value.length === 0;
  if (typeof value !== "object" || Array.isArray(value)) return false;
  const obj = value as Record<string, JsonValue>;
  if (typeof obj.cultureInvariantString === "string" && obj.cultureInvariantString.length > 0) return false;
  if (typeof obj.sourceString === "string" && obj.sourceString.length > 0) return false;
  if (typeof obj.text === "string" && obj.text.length > 0) return false;
  const historyType = Number(obj.historyType ?? FTextHistoryType.None);
  return historyType === FTextHistoryType.None;
}

function asFTextJson(value: JsonValue): FTextJson {
  if (typeof value === "string") {
    if (value.length === 0) {
      return { flags: 0, historyType: FTextHistoryType.None };
    }
    return {
      flags: FTEXT_FLAG_CULTURE_INVARIANT,
      historyType: FTextHistoryType.None,
      cultureInvariantString: value,
    };
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, JsonValue>;
    const text =
      typeof obj.text === "string"
        ? obj.text
        : typeof obj.cultureInvariantString === "string"
          ? obj.cultureInvariantString
          : typeof obj.sourceString === "string"
            ? obj.sourceString
            : undefined;
    const historyType = Number(obj.historyType ?? (text ? FTextHistoryType.None : FTextHistoryType.None));
    const flags =
      obj.flags !== undefined
        ? Number(obj.flags)
        : text && historyType === FTextHistoryType.None
          ? FTEXT_FLAG_CULTURE_INVARIANT
          : 0;

    if (historyType === FTextHistoryType.Base) {
      return {
        flags,
        historyType,
        namespace: String(obj.namespace ?? ""),
        key: String(obj.key ?? ""),
        sourceString: String(obj.sourceString ?? text ?? ""),
      };
    }

    return {
      flags,
      historyType: FTextHistoryType.None,
      cultureInvariantString: text,
    };
  }
  return { flags: 0, historyType: FTextHistoryType.None };
}

/** Read cooked FText (UE 5.1: Flags + HistoryType + history payload). */
export function readFText(reader: BinaryReader, names: readonly string[] = []): JsonValue {
  const flags = reader.readUInt32();
  const historyType = reader.readInt8();

  if (historyType === FTextHistoryType.None) {
    const hasCultureInvariantString = reader.readInt32() !== 0;
    if (hasCultureInvariantString) {
      const cultureInvariantString = reader.readFString();
      return {
        flags,
        historyType,
        cultureInvariantString,
        text: cultureInvariantString,
      };
    }
    return { flags, historyType, text: "" };
  }

  if (historyType === FTextHistoryType.Base) {
    const namespace = reader.readFString();
    const key = reader.readFString();
    const sourceString = reader.readFString();
    return {
      flags,
      historyType,
      namespace,
      key,
      sourceString,
      text: sourceString,
    };
  }

  if (historyType === FTextHistoryType.StringTableEntry) {
    const tableId = reader.readFName(names);
    const key = reader.readFString();
    return {
      flags,
      historyType,
      tableId: tableId.text,
      tableIdIndex: tableId.index,
      tableIdNumber: tableId.number,
      key,
      text: key,
    };
  }

  throw new Error(
    `Unsupported FText history type ${historyType} (supported: None, Base, StringTableEntry)`,
  );
}

/** Write cooked FText. Accepts a plain string (culture-invariant) or structured JSON. */
export function writeFText(writer: BinaryWriter, value: JsonValue): void {
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Number((value as Record<string, JsonValue>).historyType) === FTextHistoryType.StringTableEntry
  ) {
    const obj = value as Record<string, JsonValue>;
    writer.writeUInt32(Number(obj.flags ?? 0));
    writer.writeInt8(FTextHistoryType.StringTableEntry);
    const index = Number(obj.tableIdIndex ?? 0);
    const number = Number(obj.tableIdNumber ?? 0);
    writer.writeFName({ index, number });
    writer.writeFString(String(obj.key ?? ""));
    return;
  }

  const text = asFTextJson(value);
  writer.writeUInt32(text.flags >>> 0);
  writer.writeInt8(text.historyType);

  if (text.historyType === FTextHistoryType.Base) {
    writer.writeFString(text.namespace ?? "");
    writer.writeFString(text.key ?? "");
    writer.writeFString(text.sourceString ?? "");
    return;
  }

  // None (+ optional culture-invariant string). UE 5.1 always serializes the bool.
  const invariant = text.cultureInvariantString ?? "";
  if (invariant.length > 0) {
    writer.writeInt32(1);
    writer.writeFString(invariant);
  } else {
    writer.writeInt32(0);
  }
}
