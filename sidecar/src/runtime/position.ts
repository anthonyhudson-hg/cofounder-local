/**
 * Next `position` value after a queried `MAX(position)`.
 *
 * Treats null/undefined/non-numeric (no existing rows) as -1 so the first row
 * lands at 0. The important part is using `Number.isFinite` rather than the
 * previous `(Number(max ?? -1) || -1) + 1`: when the real current max was 0,
 * `0 || -1` evaluated to -1, so the next row also got 0 and COLLIDED with the
 * existing row at 0 — e.g. a new department stacking on top of the seeded
 * "Executive" at position 0, or the 2nd company piling onto the 1st (report T1.5).
 */
export function nextPositionAfter(currentMax: number | string | null | undefined): number {
  const n = Number(currentMax ?? -1);
  return (Number.isFinite(n) ? n : -1) + 1;
}
