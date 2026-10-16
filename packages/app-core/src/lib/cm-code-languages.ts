/**
 * Eager code-fence language registry for the markdown editor.
 *
 * `@codemirror/language-data` is the canonical source of truth for
 * language descriptions but it drives loading through dynamic
 * `import('@codemirror/lang-…')` calls that don't resolve reliably in
 * our Electron bundling pipeline — the result is fenced code blocks for
 * Python/Go/Rust/etc. rendering as plaintext in edit mode while
 * TypeScript (already loaded via the markdown grammar's dependency
 * chain) works fine.
 *
 * We fix that by pre-importing each grammar we care about and exposing
 * a resolver function in the shape that `markdown({ codeLanguages })`
 * accepts. The resolver also falls back to `language-data`'s lazy list
 * so less common languages still get a chance to load if bundling
 * happens to work for them.
 */
import { LanguageDescription, type Language, LanguageSupport, StreamLanguage } from '@codemirror/language'
import { languages as lazyLanguages } from '@codemirror/language-data'

import { javascript } from '@codemirror/lang-javascript'
import { python } from '@codemirror/lang-python'
import { rust } from '@codemirror/lang-rust'
import { go } from '@codemirror/lang-go'
import { json } from '@codemirror/lang-json'
import { cpp } from '@codemirror/lang-cpp'
import { java } from '@codemirror/lang-java'
import { html } from '@codemirror/lang-html'
import { css } from '@codemirror/lang-css'
import { sql } from '@codemirror/lang-sql'
import { xml } from '@codemirror/lang-xml'
import { yaml } from '@codemirror/legacy-modes/mode/yaml'
import { markdown } from '@codemirror/lang-markdown'
import { php } from '@codemirror/lang-php'
import { shell } from '@codemirror/legacy-modes/mode/shell'
import { powerShell } from '@codemirror/legacy-modes/mode/powershell'
import { csharp, kotlin, scala, dart } from '@codemirror/legacy-modes/mode/clike'
import { groovy } from '@codemirror/legacy-modes/mode/groovy'
import { swift } from '@codemirror/legacy-modes/mode/swift'
import { toml } from '@codemirror/legacy-modes/mode/toml'
import { properties } from '@codemirror/legacy-modes/mode/properties'
import { sCSS, less } from '@codemirror/legacy-modes/mode/css'
import { sass } from '@codemirror/legacy-modes/mode/sass'

/** Map from fence-tag alias (lowercased, no dashes) to an eagerly loaded grammar. */
type Entry = { aliases: string[]; support: LanguageSupport }

const EAGER: Entry[] = [
  {
    aliases: ['javascript', 'js', 'jsx', 'node', 'nodejs', 'mjs', 'cjs'],
    support: javascript({ jsx: true })
  },
  {
    aliases: ['typescript', 'ts', 'tsx'],
    support: javascript({ jsx: true, typescript: true })
  },
  { aliases: ['python', 'py', 'python3'], support: python() },
  { aliases: ['rust', 'rs'], support: rust() },
  { aliases: ['go', 'golang'], support: go() },
  { aliases: ['json', 'jsonc'], support: json() },
  // JSON5 permits comments, bare keys, and single-quoted strings.
  { aliases: ['json5'], support: javascript() },
  {
    aliases: ['cpp', 'c++', 'c', 'cc', 'cxx', 'hpp', 'h'],
    support: cpp()
  },
  { aliases: ['java'], support: java() },
  { aliases: ['kotlin', 'kt', 'kts'], support: new LanguageSupport(StreamLanguage.define(kotlin)) },
  { aliases: ['csharp', 'cs', 'c#'], support: new LanguageSupport(StreamLanguage.define(csharp)) },
  { aliases: ['scala'], support: new LanguageSupport(StreamLanguage.define(scala)) },
  { aliases: ['groovy', 'gradle'], support: new LanguageSupport(StreamLanguage.define(groovy)) },
  { aliases: ['swift'], support: new LanguageSupport(StreamLanguage.define(swift)) },
  { aliases: ['dart'], support: new LanguageSupport(StreamLanguage.define(dart)) },
  {
    aliases: ['shell', 'bash', 'sh', 'zsh', 'console', 'shellscript', 'fish', 'env'],
    // Fish/console use shell tokenization, matching Android's shared shell role.
    support: new LanguageSupport(StreamLanguage.define({ ...shell, token(stream, state) {
      const token = shell.token(stream, state)
      return token === 'def' ? 'variableName.special' : token
    } }))
  },
  { aliases: ['powershell', 'ps1'], support: new LanguageSupport(StreamLanguage.define(powerShell)) },
  // Vue/Svelte receive HTML tag/attribute highlighting, as on Android.
  { aliases: ['html', 'htm', 'xhtml', 'vue', 'svelte'], support: html() },
  { aliases: ['css'], support: css() },
  { aliases: ['scss'], support: new LanguageSupport(StreamLanguage.define(sCSS)) },
  { aliases: ['less'], support: new LanguageSupport(StreamLanguage.define(less)) },
  { aliases: ['sass'], support: new LanguageSupport(StreamLanguage.define(sass)) },
  { aliases: ['sql', 'mysql', 'postgres', 'postgresql', 'sqlite', 'psql', 'pgsql', 'plsql', 'tsql', 'mssql', 'bigquery'], support: sql() },
  { aliases: ['xml', 'svg', 'plist'], support: xml() },
  // The LR YAML parser leaves plain scalars (including numbers/booleans)
  // untagged. The stream parser supplies Android's scalar colour roles.
  { aliases: ['yaml', 'yml'], support: new LanguageSupport(StreamLanguage.define({
    ...yaml, token(stream, state) {
      const token = yaml.token(stream, state)
      return token === 'atom' ? 'propertyName' : token === 'meta' ? 'punctuation' : token
    }
  })) },
  { aliases: ['toml'], support: new LanguageSupport(StreamLanguage.define(toml)) },
  { aliases: ['ini', 'properties'], support: new LanguageSupport(StreamLanguage.define(properties)) },
  { aliases: ['markdown', 'md'], support: markdown() },
  { aliases: ['php'], support: php() }
]

const aliasMap = new Map<string, LanguageSupport>()
for (const entry of EAGER) {
  for (const a of entry.aliases) aliasMap.set(a, entry.support)
}

function normalize(info: string): string {
  return info.trim().split(/\s+/, 1)[0].toLowerCase().replace(/[^a-z0-9+#]/g, '')
}

/**
 * Resolver function passed to `markdown({ codeLanguages: … })`. Returns
 * a `Language` for an already-loaded grammar, a `LanguageDescription`
 * for a lazy fallback from `@codemirror/language-data`, or `null` when
 * no grammar is available.
 */
export function resolveCodeLanguage(
  info: string
): Language | LanguageDescription | null {
  const key = normalize(info)
  if (!key || ['text', 'txt', 'plain', 'plaintext'].includes(key)) return null
  const eager = aliasMap.get(key)
  if (eager) return eager.language
  // Fall back to language-data's lazy list for less common fence tags
  // (Lua, Ruby, etc.).
  return LanguageDescription.matchLanguageName(lazyLanguages, key, true)
}
