import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { BinaryReader, BinaryWriter } from "../dist/io/binary.js";
import { parseUsmap, SchemaRegistry } from "../dist/schema/usmap.js";
import {
  collectRequiredFNameStrings,
  readStruct,
  writeStruct,
} from "../dist/unversioned/serializer.js";

// Regression tests for FName-serialized enum arrays (e.g.
// GameDataTableRow_Attack.AttackTransitionKind): patch JSON must accept
// both the string labels shown by `dump` and raw numeric wire values.
describe("FName-serialized enum arrays accept strings and numbers", () => {
  let registry;
  let schema;
  const NAMES = [
    "None",
    "EGameAttackTransitionKind::None",
    "EGameAttackTransitionKind::NormalAttack_2",
    "EGameAttackTransitionKind::NormalAttack_2_1",
  ];

  before(() => {
    const usmapPath = new URL("../mappings.usmap", import.meta.url);
    registry = new SchemaRegistry(parseUsmap(readFileSync(usmapPath)));
    schema = registry.getFlattenedSchema("GameDataTableRow_Attack");
    assert.ok(schema, "GameDataTableRow_Attack schema must exist");
  });

  function write(values, names = NAMES) {
    const writer = new BinaryWriter();
    writeStruct(writer, schema, values, { names, registry }, { mode: "dense" });
    return writer.toBuffer();
  }

  function roundTrip(values, names = NAMES) {
    const buf = write(values, names);
    const back = readStruct(new BinaryReader(buf), schema, { names, registry });
    return { buf, back };
  }

  it("serializes numeric wires and string labels to identical bytes", () => {
    const fromNumbers = write({ AttackTransitionKind: [5, 7] });
    const fromLabels = write({
      AttackTransitionKind: [
        "EGameAttackTransitionKind::NormalAttack_2",
        "EGameAttackTransitionKind::NormalAttack_2_1",
      ],
    });
    assert.ok(fromNumbers.equals(fromLabels), "number and label forms must match byte-for-byte");
  });

  it("reads numeric-written arrays back as labels", () => {
    const { back } = roundTrip({ AttackTransitionKind: [5, 7] });
    assert.deepEqual(back.AttackTransitionKind, [
      "EGameAttackTransitionKind::NormalAttack_2",
      "EGameAttackTransitionKind::NormalAttack_2_1",
    ]);
  });

  it("accepts mixed numbers and labels in one array", () => {
    const mixed = write({ AttackTransitionKind: [5, "EGameAttackTransitionKind::NormalAttack_2_1"] });
    const numbers = write({ AttackTransitionKind: [5, 7] });
    assert.ok(mixed.equals(numbers));
  });

  it("throws on a wire value with no enum mapping instead of writing garbage", () => {
    assert.throws(
      () => write({ AttackTransitionKind: [999] }),
      /not a valid wire value of EGameAttackTransitionKind/,
    );
  });

  it("collects mapped labels for numbers, never numeric garbage names", () => {
    const missing = collectRequiredFNameStrings(schema, { AttackTransitionKind: [5, 7] }, NAMES, registry);
    assert.deepEqual([...missing], []);
    assert.ok(!missing.includes("5") && !missing.includes("7"));

    // Valid-but-unreferenced wire resolves to the prefixed FName for interning.
    const missingFresh = collectRequiredFNameStrings(
      schema,
      { AttackTransitionKind: [5] },
      ["None"],
      registry,
    );
    assert.deepEqual([...missingFresh], ["EGameAttackTransitionKind::NormalAttack_2"]);
  });

  it("scalar enums accept numbers, short labels and prefixed labels", () => {
    const fromNumber = write({ AttackTransitionType: 2 });
    const fromShort = write({ AttackTransitionType: "InputHitWithoutGuard" });
    const fromPrefixed = write({ AttackTransitionType: "EGameAttackTransitionType::InputHitWithoutGuard" });
    assert.ok(fromNumber.equals(fromShort));
    assert.ok(fromNumber.equals(fromPrefixed));

    const { back } = roundTrip({ AttackTransitionType: 2 });
    assert.equal(back.AttackTransitionType, "InputHitWithoutGuard");
  });
});
