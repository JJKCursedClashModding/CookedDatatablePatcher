/** UE FLinearColor::Clamp01NansTo0 + ToFColorSRGB (Color.cpp). Hex is export-only (6-char RRGGBB). */
export function clamp01NansTo0(value: number): number {
  const clampedLo = value > 0 ? value : 0;
  return clampedLo < 1 ? clampedLo : 1;
}

/** Matches UE stbir__linear_to_srgb_uchar_fast closely enough for editor Hex display. */
export function linearToSrgbU8(linear: number): number {
  const c = clamp01NansTo0(linear);
  const srgb = c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
  return Math.min(255, Math.max(0, Math.round(srgb * 255)));
}

/** JJK reference JSON uses RRGGBB from linear RGB via sRGB quantization (not QuantizeRound). */
export function linearColorToHex(R: number, G: number, B: number): string {
  return [linearToSrgbU8(R), linearToSrgbU8(G), linearToSrgbU8(B)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

export function defaultNativeStructJson(structName: string): Record<string, number | string> {
  switch (structName) {
    case "Vector":
      return { X: 0, Y: 0, Z: 0 };
    case "Rotator":
      return { Pitch: 0, Yaw: 0, Roll: 0 };
    case "Vector2D":
      return { X: 0, Y: 0 };
    case "Vector4":
      return { X: 0, Y: 0, Z: 0, W: 0 };
    case "LinearColor":
      return { R: 0, G: 0, B: 0, A: 1, Hex: "000000" };
    case "Color":
      return { R: 0, G: 0, B: 0, A: 255 };
    default:
      return {};
  }
}

export function isNativeStructZero(
  structName: string | undefined,
  value: Record<string, unknown>,
): boolean {
  const num = (v: unknown) => Number(v ?? 0);
  switch (structName) {
    case "Vector":
      return num(value.X) === 0 && num(value.Y) === 0 && num(value.Z) === 0;
    case "Rotator":
      return (
        num(value.Pitch ?? value.X) === 0 &&
        num(value.Yaw ?? value.Y) === 0 &&
        num(value.Roll ?? value.Z) === 0
      );
    case "Vector2D":
      return num(value.X) === 0 && num(value.Y) === 0;
    case "Vector4":
      return num(value.X) === 0 && num(value.Y) === 0 && num(value.Z) === 0 && num(value.W) === 0;
    case "LinearColor":
      return num(value.R) === 0 && num(value.G) === 0 && num(value.B) === 0 && num(value.A) === 0;
    case "Color":
      return num(value.R) === 0 && num(value.G) === 0 && num(value.B) === 0 && num(value.A) === 0;
    default:
      return Object.keys(value)
        .filter((k) => k !== "Hex" && k !== "$bytes")
        .every((k) => num(value[k]) === 0);
  }
}
