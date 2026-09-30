/** Byte-identical round-trip check for BP parameter assets (dev/test gate). */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BinaryReader, BinaryWriter } from "../io/binary.js";
import { parseUsmap, SchemaRegistry } from "../schema/usmap.js";
import { readNameMap } from "../package/maps.js";
import { readPackageSummaryWithOffsets } from "../package/summary.js";
import { DEFAULT_USMAP } from "../patchTable.js";
import { readStruct, writeStruct, type BpContext } from "./codec.js";
import { SHORT_NAME_BY_ASSET } from "./parameters.js";

export interface RoundtripResult {
  readonly asset: string;
  readonly identical: boolean;
  readonly exportSize: number;
  readonly firstDiff?: number;
}

export function roundtripBp(options: {
  inputDir: string;
  assetName: string;
  usmapPath?: string;
}): RoundtripResult {
  const short = SHORT_NAME_BY_ASSET.get(options.assetName);
  if (!short) throw new Error(`Unknown parameter asset ${options.assetName}`);
  const registry = new SchemaRegistry(parseUsmap(readFileSync(options.usmapPath ?? DEFAULT_USMAP)));
  const schema = registry.getFlattenedSchema(short.className);
  if (!schema) throw new Error(`Missing schema ${short.className}`);

  const uasset = readFileSync(join(options.inputDir, `${options.assetName}.uasset`));
  const uexp = readFileSync(join(options.inputDir, `${options.assetName}.uexp`));
  const { summary } = readPackageSummaryWithOffsets(uasset);
  const names = readNameMap(uasset, summary.nameOffset, summary.nameCount);
  const stride = (summary.dependsOffset - summary.exportOffset) / summary.exportCount;

  let cdoIndex = -1;
  for (let i = 0; i < summary.exportCount; i++) {
    const nm = names[uasset.readInt32LE(summary.exportOffset + i * stride + 16)] ?? "";
    if (nm.startsWith("Default__")) cdoIndex = i;
  }
  if (cdoIndex < 0) throw new Error("No CDO export");
  const size = Number(uasset.readBigInt64LE(summary.exportOffset + cdoIndex * stride + 28));
  const off = Number(uasset.readBigInt64LE(summary.exportOffset + cdoIndex * stride + 36));
  const blob = Buffer.from(uexp.subarray(off - summary.totalHeaderSize, off - summary.totalHeaderSize + size));

  const ctx: BpContext = { names, registry, zeroStates: new WeakMap() };
  const reader = new BinaryReader(blob);
  const parsed = readStruct(reader, schema, ctx);
  const tail = Buffer.from(blob.subarray(reader.offset));
  const writer = new BinaryWriter();
  writeStruct(writer, schema, parsed, ctx);
  const out = Buffer.concat([writer.toBuffer(), tail]);

  if (out.length !== blob.length || !out.equals(blob)) {
    let firstDiff = -1;
    const n = Math.min(out.length, blob.length);
    for (let i = 0; i < n; i++) {
      if (out[i] !== blob[i]) {
        firstDiff = i;
        break;
      }
    }
    if (firstDiff < 0) firstDiff = n;
    return { asset: options.assetName, identical: false, exportSize: size, firstDiff };
  }
  return { asset: options.assetName, identical: true, exportSize: size };
}
