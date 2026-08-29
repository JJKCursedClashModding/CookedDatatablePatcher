#!/usr/bin/env node
import { Command } from "commander";
import { DEFAULT_USMAP, patchCookedDataTable } from "./patchTable.js";
import { patchModManagerDirectory } from "./modmanager.js";

const program = new Command();

program
  .name("cooked-datatable-patcher")
  .description("Patch unversioned cooked UE 5.1 DataTable packages with _ModManager JSON");

program
  .command("patch")
  .requiredOption("--table <name>", "DataTable asset base name, e.g. DamageDataTable5")
  .requiredOption("--patch <path>", "Path to _ModManager JSON patch file")
  .requiredOption("--input <dir>", "Directory containing cooked .uasset/.uexp pair")
  .requiredOption("--output <dir>", "Output directory for patched package")
  .option("--usmap <path>", "Path to .usmap mappings file", DEFAULT_USMAP)
  .option("--no-add-rows", "Do not add rows that are missing from the cooked table")
  .action((opts) => {
    const result = patchCookedDataTable({
      tableAssetName: opts.table,
      patchJsonPath: opts.patch,
      inputDir: opts.input,
      outputDir: opts.output,
      usmapPath: opts.usmap,
      addRows: opts.addRows,
    });

    console.log(
      `Patched ${result.table}: merged=${result.merged} added=${result.added} missing=${result.missing} ` +
        `export ${result.oldExportSize} -> ${result.newExportSize} bytes`,
    );
    console.log(`Wrote ${result.outputUasset}`);
    console.log(`Wrote ${result.outputUexp}`);
  });

program
  .command("patch-modmanager")
  .requiredOption("--modmanager <dir>", "Directory containing _ModManager JSON patch files")
  .requiredOption("--input <dir>", "Directory containing cooked .uasset/.uexp files")
  .requiredOption("--output <dir>", "Output directory for patched packages")
  .option("--usmap <path>", "Path to .usmap mappings file", DEFAULT_USMAP)
  .option("--no-add-rows", "Do not add rows that are missing from cooked tables")
  .option("--copy-unpatched", "Copy cooked tables without a matching _ModManager JSON into output")
  .action((opts) => {
    const summary = patchModManagerDirectory({
      modManagerDir: opts.modmanager,
      inputDir: opts.input,
      outputDir: opts.output,
      usmapPath: opts.usmap,
      addRows: opts.addRows,
      copyUnpatched: opts.copyUnpatched ?? false,
    });

    let merged = 0;
    let added = 0;
    for (const r of summary.patched) {
      merged += r.merged;
      added += r.added;
      console.log(
        `${r.table}: merged=${r.merged} added=${r.added} export ${r.oldExportSize} -> ${r.newExportSize}`,
      );
    }

    console.log(
      `\nPatched ${summary.patched.length} tables (merged=${merged} added=${added} rows)`,
    );
    if (summary.copied.length > 0) {
      console.log(`Copied ${summary.copied.length} unmodified tables`);
    }
    if (summary.skipped.length > 0) {
      console.log(`Skipped ${summary.skipped.length} (no cooked asset): ${summary.skipped.join(", ")}`);
    }
    if (summary.errors.length > 0) {
      console.error(`\n${summary.errors.length} error(s):`);
      for (const e of summary.errors) console.error(`  ${e.table}: ${e.error}`);
      process.exitCode = 1;
    }
  });

program
  .command("dump")
  .requiredOption("--table <name>", "DataTable asset base name")
  .requiredOption("--input <dir>", "Directory containing cooked package")
  .option("--usmap <path>", "Path to .usmap mappings file", DEFAULT_USMAP)
  .option("--row <name>", "Dump only one row")
  .action(async (opts) => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { parseUsmap, SchemaRegistry } = await import("./schema/usmap.js");
    const { loadCookedPackageFromDir } = await import("./package/reader.js");
    const { parseDataTableExport } = await import("./datatable/patch.js");

    const registry = new SchemaRegistry(parseUsmap(readFileSync(opts.usmap)));
    const pkg = loadCookedPackageFromDir(opts.input, opts.table);
    const parsed = parseDataTableExport(pkg, registry);
    const rows = opts.row ? parsed.rows.filter((r) => r.name === opts.row) : parsed.rows;
    console.log(
      JSON.stringify(
        {
          package: pkg.summary.packageName,
          rowStruct: parsed.rowStructName,
          rowCount: parsed.rows.length,
          rows,
        },
        null,
        2,
      ),
    );
  });

program.parse();
