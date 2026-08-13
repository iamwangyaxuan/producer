/** `16:9` as a number, for CSS and for working out a pixel size. */
export function aspectRatioValue(ratio: string | undefined) {
  if (!ratio) return undefined;

  const [width, height] = ratio.split(":").map(Number);

  if (!width || !height) return undefined;

  return width / height;
}
