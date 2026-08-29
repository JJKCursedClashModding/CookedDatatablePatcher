import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { patchCookedDataTable, type PatchResult } from "./patchTable.js";

export interface ModManagerPatchOptions {
  readonly modManagerDir: string;
  readonly inputDir: string;
  readonly outputDir: string;
  readonly usmapPath?: string;
  /** Add rows that exist in JSON but not in the cooked table (default true). */
  readonly addRows?: boolean;
  /** Copy unmodified cooked tables into output so the directory is complete. */
  readonly copyUnpatched?: boolean;
}

export interface ModManagerPatchError {
  readonly table: string;
  readonly error: string;
}

export interface ModManagerPatchSummary {
  readonly patched: readonly PatchResult[];
  readonly copied: readonly string[];
  readonly skipped: readonly string[];
  readonly errors: readonly ModManagerPatchError[];
}

function listCookedTables(dir: string): string[] {
  return readdirSync(dir)
    .filter((f: string) => f.endsWith(".uasset"))
    .map((f: string) => f.replace(/\.uasset$/, ""));
}

function listModManagerTables(dir: string): string[] {
  return readdirSync(dir)
    .filter((f: string) => f.endsWith(".json"))
    .map((f: string) => f.replace(/\.json$/, ""));
}

function copyCookedTable(inputDir: string, outputDir: string, table: string): void {
  for (const ext of [".uasset", ".uexp"] as const) {
    const src = join(inputDir, `${table}${ext}`);
    if (!existsSync(src)) {
      throw new Error(`Missing cooked file: ${src}`);
    }
    copyFileSync(src, join(outputDir, `${table}${ext}`));
  }
}

/** Patch every JSON file in a _ModManager directory against matching cooked DataTables. */
export function patchModManagerDirectory(options: ModManagerPatchOptions): ModManagerPatchSummary {
  mkdirSync(options.outputDir, { recursive: true });

  const modTables = listModManagerTables(options.modManagerDir);
  const cookedTables = new Set(listCookedTables(options.inputDir));
  const patched: PatchResult[] = [];
  const copied: string[] = [];
  const skipped: string[] = [];
  const errors: ModManagerPatchError[] = [];
  /** Tables that had a matching JSON (success or failure) — never copy originals for these. */
  const attempted = new Set<string>();

  for (const table of modTables) {
    const patchPath = join(options.modManagerDir, `${table}.json`);
    if (!cookedTables.has(table)) {
      skipped.push(table);
      continue;
    }

    attempted.add(table);
    try {
      patched.push(
        patchCookedDataTable({
          inputDir: options.inputDir,
          outputDir: options.outputDir,
          tableAssetName: table,
          patchJsonPath: patchPath,
          usmapPath: options.usmapPath,
          addRows: options.addRows ?? true,
        }),
      );
    } catch (err) {
      errors.push({ table, error: (err as Error).message });
    }
  }

  if (options.copyUnpatched) {
    for (const table of cookedTables) {
      if (attempted.has(table)) continue;
      copyCookedTable(options.inputDir, options.outputDir, table);
      copied.push(table);
    }
  }

  return { patched, copied, skipped, errors };
}
