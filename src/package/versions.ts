// UE 5.1 object version thresholds used by Jujutsu Kaisen CC (Engine 5.1).
// Values from Epic EUnrealEngineObjectUE4/UE5Version enums (CUE4Parse reference).

export const UE5_1 = {
  legacyFileVersion: -8,
  fileVersionUE4: 522, // AUTOMATIC_VERSION baseline for UE5.1
  fileVersionUE5: 1012,
  fileVersionLicenseeUE: 0,
} as const;

export const UE4_VER = {
  OLDEST_LOADABLE_PACKAGE: 214,
  NAME_HASHES_SERIALIZED: 357,
  ADDED_SEARCHABLE_NAMES: 401,
  PRELOAD_DEPENDENCIES_IN_COOKED_EXPORTS: 507,
  COOKED_ASSETS_IN_EDITOR_SUPPORT: 516,
  e64BIT_EXPORTMAP_SERIALSIZES: 444,
  LOAD_FOR_EDITOR_GAME: 435,
} as const;

export const UE5_VER = {
  PACKAGE_SAVED_HASH: 1001,
  ADD_SOFTOBJECTPATH_LIST: 1003,
  REMOVE_OBJECT_EXPORT_PACKAGE_GUID: 1004,
  TRACK_OBJECT_EXPORT_IS_INHERITED: 1005,
  OPTIONAL_RESOURCES: 1006,
  SCRIPT_SERIALIZATION_OFFSET: 1011,
  NAMES_REFERENCED_FROM_EXPORT_DATA: 1013,
  PAYLOAD_TOC: 1014,
  DATA_RESOURCES: 1015,
  TEMPLATE_INDEX_IN_COOKED_EXPORTS: 1002,
} as const;

export const PACKAGE_FILE_TAG = 0x9e2a83c1;

export const PKG = {
  Cooked: 0x200,
  UnversionedProperties: 0x2000,
  FilterEditorOnly: 0x80000000,
} as const;
