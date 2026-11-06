/** Longest ordered hashtag prefix that shares at most two flex rows with model nodes.
 * Each prefix is visited once; testing its overflow chip takes constant work.
 */
export function fitCandidateTags({
  width,
  gap,
  modelWidths,
  tagWidths,
  moreWidths,
}: {
  width: number;
  gap: number;
  modelWidths: number[];
  tagWidths: number[];
  moreWidths: number[];
}) {
  if (width <= 0) return 0;
  type Line = { row: number; used: number };
  const append = (line: Line, next: number): Line => {
    if (next > width) return { row: 3, used: next };
    return line.used > 0 && line.used + gap + next > width
      ? { row: line.row + 1, used: next }
      : { row: line.row, used: line.used + (line.used > 0 ? gap : 0) + next };
  };
  let line: Line = { row: 1, used: 0 };
  for (const modelWidth of modelWidths) line = append(line, modelWidth);
  let visible = 0;
  for (let count = 0; count <= tagWidths.length; count++) {
    if (line.row > 2) break;
    const remaining = tagWidths.length - count;
    const more =
      moreWidths[String(remaining).length - 1] ?? moreWidths.at(-1) ?? 0;
    if (!remaining || append(line, more).row <= 2) visible = count;
    if (count < tagWidths.length) line = append(line, tagWidths[count]);
  }
  return visible;
}
