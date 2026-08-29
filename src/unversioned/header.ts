import { BinaryReader, BinaryWriter } from "../io/binary.js";

export interface UnversionedFragment {
  readonly skipNum: number;
  readonly hasZeroes: boolean;
  readonly isLast: boolean;
  readonly valueCount: number;
}

export interface UnversionedHeader {
  readonly fragments: readonly UnversionedFragment[];
  readonly zeroMask: Buffer;
}

export function readUnversionedHeader(reader: BinaryReader): UnversionedHeader {
  const fragments: UnversionedFragment[] = [];
  let zeroBits = 0;
  let isLast = false;

  while (!isLast) {
    const packed = reader.readUInt16();
    const fragment: UnversionedFragment = {
      skipNum: packed & 0x7f,
      hasZeroes: (packed & 0x80) !== 0,
      isLast: (packed & 0x100) !== 0,
      valueCount: packed >> 9,
    };
    isLast = fragment.isLast;
    fragments.push(fragment);
    if (fragment.hasZeroes) zeroBits += fragment.valueCount;
  }

  let zeroMask = Buffer.alloc(0);
  if (zeroBits > 0) {
    const numBytes = zeroBits <= 8 ? 1 : zeroBits <= 16 ? 2 : Math.ceil(zeroBits / 32) * 4;
    zeroMask = Buffer.from(reader.readBytes(numBytes));
  }

  return { fragments, zeroMask };
}

export function writeUnversionedHeader(writer: BinaryWriter, header: UnversionedHeader): void {
  for (const fragment of header.fragments) {
    let packed = fragment.skipNum & 0x7f;
    if (fragment.hasZeroes) packed |= 0x80;
    if (fragment.isLast) packed |= 0x100;
    packed |= (fragment.valueCount & 0x7f) << 9;
    writer.writeUInt16(packed);
  }
  if (header.zeroMask.length > 0) {
    writer.writeBytes(header.zeroMask);
  }
}

export function zeroMaskBit(mask: Buffer, index: number): boolean {
  const byteIndex = Math.floor(index / 8);
  const bitIndex = index % 8;
  if (byteIndex >= mask.length) return false;
  return ((mask[byteIndex] >> bitIndex) & 1) === 1;
}

export function buildZeroMask(bits: readonly boolean[]): Buffer {
  if (bits.length === 0) return Buffer.alloc(0);
  const numBytes = bits.length <= 8 ? 1 : bits.length <= 16 ? 2 : Math.ceil(bits.length / 32) * 4;
  const mask = Buffer.alloc(numBytes, 0);
  for (let i = 0; i < bits.length; i++) {
    if (bits[i]) {
      mask[Math.floor(i / 8)] |= 1 << (i % 8);
    }
  }
  return mask;
}

export interface UnversionedReadState {
  readonly header: UnversionedHeader;
  readonly valuesStart: number;
  readonly valuesEnd: number;
}

export function locateUnversionedValues(reader: BinaryReader): UnversionedReadState {
  const start = reader.offset;
  const header = readUnversionedHeader(reader);
  const valuesStart = reader.offset;
  return { header, valuesStart, valuesEnd: reader.offset };
}

export function readUnversionedValuesSlice(reader: BinaryReader, state: UnversionedReadState): Buffer {
  const end = reader.offset;
  reader.seek(state.valuesStart);
  const bytes = reader.readBytes(end - state.valuesStart);
  reader.seek(end);
  return bytes;
}
