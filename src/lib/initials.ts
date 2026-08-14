/**
 * The letter that stands in for a face — a person's, an organization's, or a
 * project's cover.
 *
 * The first *grapheme* rather than the first byte, so 王雅萱 gets 王 and not a
 * broken glyph. Trimmed first because not every caller's string has been:
 * an organization name is an editable column, and a collaborator's name
 * arrives through awareness from whatever that person's client wrote.
 */
export function initial(name: string) {
  return [...name.trim()][0]?.toUpperCase() ?? "?";
}
