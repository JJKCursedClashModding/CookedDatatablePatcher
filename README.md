# Cooked Datatable Patcher

Patch unversioned cooked UE 5.1 DataTable `.uasset` / `.uexp` pairs using `_ModManager` JSON.

## Requirements

- Node.js 18+
- A `.usmap` mappings file (this repo ships `mappings.usmap` for Jujutsu Kaisen Cursed Clash)

## Install

```bash
npm install
npm run build
```

## CLI

```bash
# Patch one table
npx cooked-datatable-patcher patch \
  --table DamageDataTable5 \
  --patch path/to/DamageDataTable5.json \
  --input path/to/CookedDatatables \
  --output path/to/output

# Patch every JSON in a _ModManager folder
npx cooked-datatable-patcher patch-modmanager \
  --modmanager path/to/_ModManager \
  --input path/to/CookedDatatables \
  --output path/to/output \
  --copy-unpatched

# Dump cooked rows as JSON
npx cooked-datatable-patcher dump \
  --table DamageDataTable5 \
  --input path/to/CookedDatatables
```

### Options

| Flag | Description |
|------|-------------|
| `--usmap <path>` | Override mappings file (default: `mappings.usmap` next to the package) |
| `--no-add-rows` | Do not insert rows that exist only in the JSON |
| `--copy-unpatched` | With `patch-modmanager`, copy cooked tables that have no JSON into the output |
| `--row <name>` | With `dump`, emit a single row |

## Patch JSON format

Top-level object: row name → field map.

```json
{
  "SomeRow": {
    "Damage": 12.5,
    "DisplayName": "Hello"
  }
}
```

- Missing cooked rows are **added** by default (disable with `--no-add-rows`).
- `TextProperty` values may be a plain string (written as culture-invariant FText) or a structured object (`flags`, `historyType`, `sourceString`, …).

## Library

```ts
import { patchCookedDataTable, patchModManagerDirectory } from "cooked-datatable-patcher";
```

## Notes

- Targets **UE 5.1** cooked packages with unversioned properties.
- Extends the package name map when new FName values are required.
- `mappings.usmap` at the repo root is the mappings file used by default.
