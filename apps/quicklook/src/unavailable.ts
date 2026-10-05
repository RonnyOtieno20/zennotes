/** Typst math and the plot renderers are not part of the Quick Look preview:
 * math typesets with KaTeX, and a plot shows its source. */
function unavailable(): never {
  throw new Error('This renderer is not part of the Quick Look preview. Open the note in ZenNotes to see it.')
}
export const JSXGraph = { initBoard: unavailable }
export default Object.assign(unavailable, { JSXGraph })
