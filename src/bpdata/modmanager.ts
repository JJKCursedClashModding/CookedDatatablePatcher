/**
 * Batch Blueprint parameter patching for the mod-manager `parameters/` flow.
 *
 * Input:  `<parametersDir>/<shortName>.json` — already merged across enabled
 *         mods by `lib/packageAllMods.js` (priority-ascending, highest wins).
 * Base:   `<inputDir>/<AssetName>.{uasset,uexp}` pristine pairs + SHA-256
 *         manifest (`base-manifest.json`) for game-update detection.
 * Output: patched pairs for touched assets only (no-op build ships nothing).
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { patchBpParameter, type BpPatchResult } from "./patch.js";
import { DEFAULT_USMAP } from "../patchTable.js";
import { parseUsmap, SchemaRegistry } from "../schema/usmap.js";
import { ASSET_BY_SHORT_NAME } from "./parameters.js";

export interface ParameterBatchOptions {
  readonly parametersDir: string;
  readonly inputDir: string;
  readonly outputDir: string;
  readonly manifestPath?: string;
  readonly usmapPath?: string;
  /** Pre-parsed schema registry shared across all assets in the batch. */
  readonly registry?: SchemaRegistry;
}

export interface ParameterBatchError {
  readonly shortName: string;
  readonly error: string;
}

export interface ParameterBatchSummary {
  readonly patched: readonly BpPatchResult[];
  readonly skipped: readonly string[];
  readonly errors: readonly ParameterBatchError[];
}

export interface BaseManifest {
  readonly version: number;
  readonly files: Record<string, { sha256: string; size: number }>;
}

function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** Fail loudly when a pristine base no longer matches the recorded hash. */
export function verifyBaseManifest(inputDir: string, manifestPath: string): void {
  if (!existsSync(manifestPath)) {
    throw new Error(
      `Missing parameter base manifest at ${manifestPath}. ` +
        `Re-extract pristine bases (see README parameters/ section).`,
    );
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as BaseManifest;
  const problems: string[] = [];
  for (const [rel, entry] of Object.entries(manifest.files ?? {})) {
    const abs = join(inputDir, rel);
    if (!existsSync(abs)) {
      problems.push(`${rel}: missing`);
      continue;
    }
    const buf = readFileSync(abs);
    if (buf.length !== entry.size || sha256Hex(buf) !== entry.sha256) {
      problems.push(`${rel}: hash mismatch (game updated?)`);
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `Parameter base assets changed:\n  ${problems.join("\n  ")}\n` +
        `Re-extract pristine bases into ${inputDir} and refresh ${manifestPath}.`,
    );
  }
}

function listParameterJsons(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith(".json"))
    .map((f) => f.replace(/\.json$/i, ""));
}

/** Patch every merged `parameters/*.json` against its pristine cooked base. */
export function patchParameterDirectory(options: ParameterBatchOptions): ParameterBatchSummary {
  mkdirSync(options.outputDir, { recursive: true });

  if (options.manifestPath) {
    verifyBaseManifest(options.inputDir, options.manifestPath);
  }

  // Parse the usmap once per batch (same 1.5MB brotli cost as datatables).
  const sharedRegistry =
    options.registry ?? new SchemaRegistry(parseUsmap(readFileSync(options.usmapPath ?? DEFAULT_USMAP)));

  const shorts = listParameterJsons(options.parametersDir);
  const patched: BpPatchResult[] = [];
  const skipped: string[] = [];
  const errors: ParameterBatchError[] = [];

  for (const shortName of shorts) {
    if (!ASSET_BY_SHORT_NAME.has(shortName)) {
      const valid = [...ASSET_BY_SHORT_NAME.keys()].join(", ");
      errors.push({ shortName, error: `unknown parameter file; expected one of: ${valid}` });
      continue;
    }
    const patchPath = join(options.parametersDir, `${shortName}.json`);
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(patchPath, "utf8"));
    } catch (err) {
      errors.push({ shortName, error: `invalid JSON: ${(err as Error).message}` });
      continue;
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).length === 0) {
      skipped.push(shortName);
      continue;
    }
    try {
      patched.push(
        patchBpParameter({
          inputDir: options.inputDir,
          outputDir: options.outputDir,
          shortName,
          patchJsonPath: patchPath,
          usmapPath: options.usmapPath,
          registry: sharedRegistry,
        }),
      );
    } catch (err) {
      errors.push({ shortName, error: (err as Error).message });
    }
  }

  return { patched, skipped, errors };
}
