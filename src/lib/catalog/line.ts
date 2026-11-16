/** The one plain line that names a catalog card: "1990 Topps #336 Ken Griffey Jr." */
export function cardLine(c: {
  year: number | null; brand: string | null; setName: string | null; cardNumber: string | null;
  player: string | null; variation: string | null;
}): string {
  const set = c.setName && c.setName.toLowerCase() !== (c.brand ?? "").toLowerCase() ? c.setName : null;
  const parts = [c.year, c.brand, set, c.cardNumber ? `#${c.cardNumber}` : null, c.player, c.variation ? `(${c.variation})` : null];
  return parts.filter((p) => p != null && p !== "").join(" ") || "Unnamed card";
}
