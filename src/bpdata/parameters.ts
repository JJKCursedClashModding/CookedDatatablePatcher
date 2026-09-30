/**
 * Blueprint parameter asset registry for JJK CC new-character registration.
 *
 * Each entry maps a mod-facing short JSON name (`parameters/<short>.json`)
 * to the cooked Blueprint data asset it patches. File layout mirrors
 * `data/datatables/` (flat `<AssetName>.{uasset,uexp}` pairs) but mods use
 * the short names below, e.g. `GameWidgetCharacterParameter_BP` -> `character.json`.
 *
 * Mod JSONs carry LITERAL row values (no donors, no cloning):
 * - sceneCapture: `{ "CP_300": "<capture asset>" }` — the value names the
 *   `GameWidgetCharacterSceneCapture_*_BP` asset to reference, either as a
 *   short character ID (`"CP_010"`) or a full package path. It must resolve
 *   to an already-imported asset (all 48 vanilla ones are).
 * - character / storyDemo / dynamicIcon: `{ "<newID>": { <full struct> } }`
 *   with usmap field names; sparse structs are fine (absent = default).
 * - exchangeImage: `{ "<costumeID>": { "Offset": {X,Y}, "entries"?: {...} } }`.
 *   Without `entries` the row goes to all 19 image-type entries; with an
 *   `entries` map (`{ "<Entry>": {X,Y}, ... }`, `E…::` prefix optional) it
 *   goes to exactly those entries with per-entry offsets.
 */
import type { BpJsonValue } from "./codec.js";

export interface BpParameterAsset {
  /** Mod-facing file stem: `parameters/<shortName>.json`. */
  readonly shortName: string;
  /** Cooked asset base name, e.g. `GameWidgetSceneCaptureParameter_BP`. */
  readonly assetName: string;
  /** Usmap schema (native parent class) for the CDO, e.g. `GameWidgetCharacterParameter`. */
  readonly className: string;
  /** Top-level map property that holds the per-character rows. */
  readonly mapProp: string;
  /**
   * `name`   — map keys are character IDs (`CP_300`).
   * `costume` — map keys are costume variation IDs (`CP_300_00`).
   */
  readonly keyKind: "name" | "costume";
  /**
   * `ref`    — map values are object refs (value = asset reference string).
   * `struct` — map values are literal structs.
   * `rows`   — map values are structs containing a row `Array`
   *            (exchangeImage only; value = `{ Offset, entries? }`).
   */
  readonly valueKind: "ref" | "struct" | "rows";
}

export const BP_PARAMETER_ASSETS: readonly BpParameterAsset[] = [
  {
    shortName: "sceneCapture",
    assetName: "GameWidgetSceneCaptureParameter_BP",
    className: "GameWidgetSceneCaptureParameter",
    mapProp: "CharacterParameterMap",
    keyKind: "name",
    valueKind: "ref",
  },
  {
    shortName: "character",
    assetName: "GameWidgetCharacterParameter_BP",
    className: "GameWidgetCharacterParameter",
    mapProp: "CharaModelViewerParameterMap",
    keyKind: "name",
    valueKind: "struct",
  },
  {
    shortName: "storyDemo",
    assetName: "GameWidgetStoryDemoParameter_BP",
    className: "GameWidgetStoryDemoParameter",
    mapProp: "CharacterParameterMap",
    keyKind: "name",
    valueKind: "struct",
  },
  {
    shortName: "exchangeImage",
    assetName: "GameWidgetExchangeImageParameter_BP",
    className: "GameWidgetExchangeImageParameter",
    mapProp: "ImageOffsetParameterMap",
    keyKind: "costume",
    valueKind: "rows",
  },
  {
    shortName: "dynamicIcon",
    assetName: "GameWidgetDynamicIconParameter_BP",
    className: "GameWidgetDynamicIconParameter",
    mapProp: "FallbackInputGuideParameterMap",
    keyKind: "costume",
    valueKind: "struct",
  },
];

export const SHORT_NAME_BY_ASSET: ReadonlyMap<string, BpParameterAsset> = new Map(
  BP_PARAMETER_ASSETS.map((a) => [a.assetName, a]),
);

export const ASSET_BY_SHORT_NAME: ReadonlyMap<string, BpParameterAsset> = new Map(
  BP_PARAMETER_ASSETS.map((a) => [a.shortName, a]),
);

/** Mod-facing row patch: new ID -> literal row value. */
export type ParameterPatch = Record<string, BpJsonValue>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate the top-level shape of a `parameters/<short>.json` document:
 * a JSON object of newID -> value. Per-kind value validation happens in
 * `patch.ts` (it knows the schemas).
 */
export function parseParameterPatch(raw: unknown, sourceLabel = "parameter JSON"): ParameterPatch {
  if (!isPlainObject(raw)) {
    throw new Error(`${sourceLabel}: expected a JSON object of newID -> row value`);
  }
  const patch: ParameterPatch = {};
  for (const [newId, entry] of Object.entries(raw)) {
    if (typeof newId !== "string" || newId.length === 0) {
      throw new Error(`${sourceLabel}: row keys must be non-empty strings`);
    }
    // `$`-prefixed keys are author annotations ($comment, $schema, …) — ignored.
    if (newId.startsWith("$")) continue;
    patch[newId] = entry as BpJsonValue;
  }
  return patch;
}
