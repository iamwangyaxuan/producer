/** `16:9` as a number, for CSS and for working out a pixel size. */
export function aspectRatioValue(ratio: string | undefined) {
  if (!ratio) return undefined;

  const [width, height] = ratio.split(":").map(Number);

  // `> 0` rather than merely truthy: a negative slipped through the old check,
  // and it is nonsense to every caller — an invalid `aspect-ratio` to CSS, and
  // the square root of a negative to anything working out a pixel size.
  if (!(width > 0) || !(height > 0)) return undefined;

  return width / height;
}
