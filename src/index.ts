export {
  DEFAULT_USMAP,
  patchCookedDataTable,
  type PatchOptions,
  type PatchResult,
} from "./patchTable.js";

export { parseUsmap, SchemaRegistry } from "./schema/usmap.js";
export { loadCookedPackage, loadCookedPackageFromDir } from "./package/reader.js";
export { parseDataTableExport, parseModPatch } from "./datatable/patch.js";
export { patchModManagerDirectory } from "./modmanager.js";
export type { ModManagerPatchOptions, ModManagerPatchSummary } from "./modmanager.js";
