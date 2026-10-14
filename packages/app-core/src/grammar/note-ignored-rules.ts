import { FRONTMATTER_BLOCK_RE, parseFrontmatterFields } from '@zennotes/shared-domain/frontmatter'
import { canIgnoreGrammarRule } from './preferences'

/**
 * Rules ignored in one note only, kept in that note's front matter:
 *
 * ```yaml
 * grammar-ignore: [EN_QUOTES, PASSIVE_VOICE]
 * ```
 *
 * The list travels with the note through renames, moves and sync, so every
 * device that reads the vault hides the same issues. Rules ignored
 * everywhere stay in the app's grammar preferences.
 */
export const NOTE_IGNORED_RULES_FIELD = 'grammar-ignore'

/** The rule IDs listed in the note's `grammar-ignore` field. */
export function noteIgnoredGrammarRules(text: string): string[] {
  const block = FRONTMATTER_BLOCK_RE.exec(text)
  if (!block) return []
  const value = parseFrontmatterFields(block[1] ?? '')[NOTE_IGNORED_RULES_FIELD]
  if (value == null) return []
  // A bare scalar may list several rules, as `tags` may.
  const entries = (Array.isArray(value) ? value : [value]).flatMap((entry) => entry.split(/[,\s]+/))
  return [...new Set(entries.map((entry) => entry.trim()).filter((entry) => entry.length > 0))]
}

export interface NoteTextChange {
  from: number
  to: number
  insert: string
}

/**
 * The smallest edit that adds `ruleId` to the note's `grammar-ignore` field,
 * creating the field, or the front matter, when it is missing. Every other
 * line of the front matter stays as it is. Null when the rule is already
 * listed or is not a rule that can be ignored.
 */
export function addNoteIgnoredGrammarRule(text: string, ruleId: string): NoteTextChange | null {
  if (!canIgnoreGrammarRule(ruleId) || noteIgnoredGrammarRules(text).includes(ruleId)) return null

  const block = FRONTMATTER_BLOCK_RE.exec(text)
  if (!block) {
    return { from: 0, to: 0, insert: `---\n${NOTE_IGNORED_RULES_FIELD}: [${ruleId}]\n---\n` }
  }

  const newline = block[0].includes('\r\n') ? '\r\n' : '\n'
  const bodyStart = block[0].indexOf('\n') + 1
  const bodyEnd = bodyStart + (block[1] ?? '').length
  const lines: { from: number; to: number; text: string }[] = []
  let position = bodyStart
  for (const line of (block[1] ?? '').split('\n')) {
    lines.push({ from: position, to: position + line.length, text: line.replace(/\r$/, '') })
    position += line.length + 1
  }

  const keyIndex = lines.findIndex((line) => {
    const key = line.text.match(/^([A-Za-z0-9_][\w-]*)\s*:/)
    return key?.[1]?.toLowerCase() === NOTE_IGNORED_RULES_FIELD
  })
  if (keyIndex < 0) {
    // Before the closing `---`. An empty front matter has no body line to follow.
    return block[1]
      ? { from: bodyEnd, to: bodyEnd, insert: `${newline}${NOTE_IGNORED_RULES_FIELD}: [${ruleId}]` }
      : { from: bodyStart, to: bodyStart, insert: `${NOTE_IGNORED_RULES_FIELD}: [${ruleId}]${newline}` }
  }

  const keyLine = lines[keyIndex]!
  const rest = keyLine.text.slice(keyLine.text.indexOf(':') + 1).trim()
  if (rest === '') {
    // A block list: add an item after the last one, indented the same way.
    let last = keyIndex
    while (last + 1 < lines.length && /^\s+-\s/.test(lines[last + 1]!.text)) last += 1
    const indent = last > keyIndex ? lines[last]!.text.match(/^\s*/)![0] : '  '
    const end = lines[last]!.from + lines[last]!.text.length
    return { from: end, to: end, insert: `${newline}${indent}- ${ruleId}` }
  }

  const rules = [...noteIgnoredGrammarRules(text), ruleId]
  return {
    from: keyLine.from,
    to: keyLine.from + keyLine.text.length,
    insert: `${NOTE_IGNORED_RULES_FIELD}: [${rules.join(', ')}]`
  }
}
