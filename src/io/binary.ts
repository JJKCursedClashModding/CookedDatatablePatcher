export function looksLikeUnversionedFragment(packed: number): boolean {
  const valueCount = packed >> 9;
  const skipNum = packed & 0x7f;
  return valueCount > 0 && valueCount <= 127 && skipNum <= 127;
}

export class BinaryReader {
  constructor(
    private readonly buffer: Buffer,
    public offset = 0,
  ) {}

  get bytes(): Buffer {
    return this.buffer;
  }

  readBitAt(byteOffset: number, bitIndex: number): boolean {
    const byte = this.buffer[byteOffset + Math.floor(bitIndex / 8)] ?? 0;
    return ((byte >> (bitIndex % 8)) & 1) === 1;
  }


  clone(at?: number): BinaryReader {
    return new BinaryReader(this.buffer, at ?? this.offset);
  }

  seek(offset: number): void {
    this.offset = offset;
  }

  readUInt8(): number {
    const v = this.buffer.readUInt8(this.offset);
    this.offset += 1;
    return v;
  }

  readInt8(): number {
    const v = this.buffer.readInt8(this.offset);
    this.offset += 1;
    return v;
  }

  readUInt16(): number {
    const v = this.buffer.readUInt16LE(this.offset);
    this.offset += 2;
    return v;
  }

  readInt16(): number {
    const v = this.buffer.readInt16LE(this.offset);
    this.offset += 2;
    return v;
  }

  readUInt32(): number {
    const v = this.buffer.readUInt32LE(this.offset);
    this.offset += 4;
    return v;
  }

  readInt32(): number {
    const v = this.buffer.readInt32LE(this.offset);
    this.offset += 4;
    return v;
  }

  readUInt64(): bigint {
    const v = this.buffer.readBigUInt64LE(this.offset);
    this.offset += 8;
    return v;
  }

  readInt64(): bigint {
    const v = this.buffer.readBigInt64LE(this.offset);
    this.offset += 8;
    return v;
  }

  readFloat(): number {
    const v = this.buffer.readFloatLE(this.offset);
    this.offset += 4;
    return v;
  }

  readDouble(): number {
    const v = this.buffer.readDoubleLE(this.offset);
    this.offset += 8;
    return v;
  }

  /** UE5 LWC: FReal serializes as double in cooked assets (CUE4Parse ReadFReal). */
  readFReal(): number {
    return this.readDouble();
  }

  readBytes(length: number): Buffer {
    const v = this.buffer.subarray(this.offset, this.offset + length);
    this.offset += length;
    return Buffer.from(v);
  }

  readFString(): string {
    const length = this.readInt32();
    if (length === 0) return "";
    if (length < 0) {
      const byteLen = -length * 2;
      const raw = this.readBytes(byteLen);
      return raw.toString("utf16le").replace(/\0+$/, "");
    }
    const raw = this.readBytes(length);
    return raw.toString("latin1").replace(/\0+$/, "");
  }

  /** DataTable row keys: 8-byte FName, or 4-byte index-only when number=0 and header follows at +4. */
  readDataTableRowName(names: readonly string[]): { index: number; number: number; text: string } {
    const index = this.readInt32();
    const afterIndex = this.offset;
    if (afterIndex + 4 > this.buffer.length) {
      return { index, number: 0, text: formatFNameText(names, index, 0) };
    }
    const next32 = this.buffer.readInt32LE(afterIndex);
    const headerAtOffset = this.buffer.readUInt16LE(afterIndex);
    const headerAfterNumber = afterIndex + 4 <= this.buffer.length - 1
      ? this.buffer.readUInt16LE(afterIndex + 4)
      : 0;

    if (looksLikeUnversionedFragment(headerAtOffset)) {
      return { index, number: 0, text: formatFNameText(names, index, 0) };
    }
    if (next32 === 0 && looksLikeUnversionedFragment(headerAfterNumber)) {
      this.readInt32();
      return { index, number: 0, text: formatFNameText(names, index, 0) };
    }
    const number = this.readInt32();
    return { index, number, text: formatFNameText(names, index, number) };
  }

  readFName(names: readonly string[]): { index: number; number: number; text: string } {
    const index = this.readInt32();
    const number = this.readInt32();
    const text = formatFNameText(names, index, number);
    return { index, number, text };
  }

  readPackageIndex(): number {
    return this.readInt32();
  }
}

export function formatFNameText(names: readonly string[], index: number, number: number): string {
  const base = index >= 0 && index < names.length ? names[index] : `__INVALID_${index}__`;
  return number > 0 ? `${base}_${number - 1}` : base;
}

/** Name-map entry required for an FName text not yet resolved against `names` (base for suffix keys). */
export function fNameComparisonIndexString(names: readonly string[], text: string): string | null {
  if (!text || text === "None") return null;
  if (parseFNameText(names, text).found) return null;

  const match = text.match(/^(.*)_(\d+)$/);
  if (match) {
    const base = match[1];
    const suffix = Number(match[2]);
    const index = names.indexOf(base);
    if (index >= 0 && formatFNameText(names, index, suffix + 1) === text) {
      return null;
    }
  }

  return text;
}

export function parseFNameText(
  names: readonly string[],
  text: string,
): { index: number; number: number; found: boolean } {
  const match = text.match(/^(.*)_(\d+)$/);
  if (match) {
    const base = match[1];
    const suffix = Number(match[2]);
    const index = names.indexOf(base);
    if (index >= 0 && formatFNameText(names, index, suffix + 1) === text) {
      return { index, number: suffix + 1, found: true };
    }
  }

  const exact = names.indexOf(text);
  if (exact >= 0) return { index: exact, number: 0, found: true };

  return { index: -1, number: 0, found: false };
}

export class BinaryWriter {
  readonly chunks: Buffer[] = [];
  private length = 0;

  get size(): number {
    return this.length;
  }

  toBuffer(): Buffer {
    return Buffer.concat(this.chunks, this.length);
  }

  private push(buf: Buffer): void {
    this.chunks.push(buf);
    this.length += buf.length;
  }

  writeUInt8(v: number): void {
    const b = Buffer.alloc(1);
    b.writeUInt8(v, 0);
    this.push(b);
  }

  writeInt8(v: number): void {
    const b = Buffer.alloc(1);
    b.writeInt8(v, 0);
    this.push(b);
  }

  writeUInt16(v: number): void {
    const b = Buffer.alloc(2);
    b.writeUInt16LE(v, 0);
    this.push(b);
  }

  writeInt16(v: number): void {
    const b = Buffer.alloc(2);
    b.writeInt16LE(v, 0);
    this.push(b);
  }

  writeInt32(v: number): void {
    const b = Buffer.alloc(4);
    b.writeInt32LE(v, 0);
    this.push(b);
  }

  writeUInt32(v: number): void {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(v, 0);
    this.push(b);
  }

  writeInt64(v: number | bigint): void {
    const b = Buffer.alloc(8);
    b.writeBigInt64LE(BigInt(v), 0);
    this.push(b);
  }

  writeUInt64(v: number | bigint): void {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(BigInt(v), 0);
    this.push(b);
  }

  writeFloat(v: number): void {
    const b = Buffer.alloc(4);
    b.writeFloatLE(v, 0);
    this.push(b);
  }

  writeDouble(v: number): void {
    const b = Buffer.alloc(8);
    b.writeDoubleLE(v, 0);
    this.push(b);
  }

  writeFReal(v: number): void {
    this.writeDouble(v);
  }

  writeBytes(buf: Buffer): void {
    this.push(Buffer.from(buf));
  }

  writeFString(value: string): void {
    if (value.length === 0) {
      this.writeInt32(0);
      return;
    }
    const needsUtf16 = [...value].some((ch) => ch.charCodeAt(0) > 127);
    if (needsUtf16) {
      const utf16 = Buffer.from(`${value}\0`, "utf16le");
      this.writeInt32(-utf16.length / 2);
      this.writeBytes(utf16);
      return;
    }
    const bytes = Buffer.from(value, "latin1");
    this.writeInt32(bytes.length + 1);
    this.writeBytes(bytes);
    this.writeUInt8(0);
  }

  writeFName(index: number, number?: number): void;
  writeFName(parts: { index: number; number: number }): void;
  writeFName(indexOrParts: number | { index: number; number: number }, number = 0): void {
    if (typeof indexOrParts === "object") {
      this.writeInt32(indexOrParts.index);
      this.writeInt32(indexOrParts.number);
    } else {
      this.writeInt32(indexOrParts);
      this.writeInt32(number);
    }
  }

  /** Mirror readDataTableRowName: 4-byte index only when number=0 and unversioned header is at +4. */
  writeDataTableRowName(index: number, number: number, nextBytes?: Buffer): void {
    if (number !== 0) {
      this.writeInt32(index);
      this.writeInt32(number);
      return;
    }
    if (
      nextBytes !== undefined &&
      nextBytes.length >= 2 &&
      looksLikeUnversionedFragment(nextBytes.readUInt16LE(0))
    ) {
      this.writeInt32(index);
      return;
    }
    this.writeInt32(index);
    this.writeInt32(0);
  }

  writeDataTableRowNameBytes(nameBytes: Buffer): void {
    this.writeBytes(nameBytes);
  }

  writePackageIndex(index: number): void {
    this.writeInt32(index);
  }
}
