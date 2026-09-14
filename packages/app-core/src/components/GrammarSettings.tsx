import { useEffect, useMemo, useRef, useState } from 'react'
import { getZenBridge } from '@zennotes/bridge-contract/bridge'
import {
  DEFAULT_GRAMMAR_PREFERENCES,
  GRAMMAR_CATEGORIES,
  classifyGrammarEndpoint,
  type GrammarPreferencesPatch
} from '../grammar/preferences'
import { probeGrammarProvider } from '../grammar/provider-health'
import type { GrammarCategory } from '../grammar/types'
import { useStore } from '../store'

interface ToggleSettingProps {
  label: string
  description: string
  checked: boolean
  disabled?: boolean
  onChange(checked: boolean): void
}

function ToggleSetting({
  label,
  description,
  checked,
  disabled,
  onChange
}: ToggleSettingProps): JSX.Element {
  return (
    <label className="flex items-center justify-between gap-4 px-5 py-4">
      <span>
        <span className="block text-sm font-medium text-ink-800">{label}</span>
        <span className="mt-1 block text-xs leading-5 text-ink-500">{description}</span>
      </span>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="h-4 w-4 shrink-0 accent-accent"
      />
    </label>
  )
}

function SettingsGroup({
  title,
  description,
  children
}: {
  title: string
  description: string
  children: React.ReactNode
}): JSX.Element {
  return (
    <section className="space-y-3">
      <div>
        <div className="text-xs font-medium uppercase tracking-[0.2em] text-ink-500">{title}</div>
        <p className="mt-1 max-w-2xl text-sm leading-6 text-ink-500">{description}</p>
      </div>
      <div className="divide-y divide-paper-300/45 overflow-hidden rounded-3xl border border-paper-300/60 bg-paper-50/45">
        {children}
      </div>
    </section>
  )
}

function categoryLabel(category: GrammarCategory): string {
  return category[0]!.toUpperCase() + category.slice(1)
}

export function GrammarSettings(): JSX.Element {
  const grammarEnabled = useStore((state) => state.grammarEnabled)
  const setGrammarEnabled = useStore((state) => state.setGrammarEnabled)
  const preferences = useStore((state) => state.grammarPreferences)
  const setPreferences = useStore((state) => state.setGrammarPreferences)
  const [endpointDraft, setEndpointDraft] = useState(preferences.endpoint)
  const [languageDraft, setLanguageDraft] = useState(preferences.language)
  const [rulesDraft, setRulesDraft] = useState(preferences.ignoredRules.join('\n'))
  const [dictionaryDraft, setDictionaryDraft] = useState(preferences.customDictionary.join('\n'))
  const [health, setHealth] = useState<
    | { phase: 'idle'; message: string }
    | { phase: 'checking'; message: string }
    | { phase: 'reachable'; message: string }
    | { phase: 'error'; message: string }
  >({ phase: 'idle', message: 'Not tested in this settings session.' })
  const healthController = useRef<AbortController | null>(null)
  const bridge = getZenBridge()
  const supported = bridge.getCapabilities().supportsGrammarProviderTransport === true
  const endpoint = classifyGrammarEndpoint(endpointDraft.trim())

  useEffect(() => setEndpointDraft(preferences.endpoint), [preferences.endpoint])
  useEffect(() => setLanguageDraft(preferences.language), [preferences.language])
  useEffect(() => setRulesDraft(preferences.ignoredRules.join('\n')), [preferences.ignoredRules])
  useEffect(
    () => setDictionaryDraft(preferences.customDictionary.join('\n')),
    [preferences.customDictionary]
  )
  useEffect(() => () => healthController.current?.abort(), [])

  const providerStatus = useMemo(() => {
    if (!supported) return 'Unavailable in this runtime'
    if (health.phase === 'checking') return 'Testing connection…'
    if (health.phase === 'reachable') return health.message
    if (health.phase === 'error') return health.message
    return `${endpoint.label} provider · ${health.message}`
  }, [endpoint.label, health, supported])

  const update = (patch: GrammarPreferencesPatch): void => setPreferences(patch)
  const commitLines = (field: 'ignoredRules' | 'customDictionary', value: string): void =>
    update({ [field]: value.split(/\r?\n/u) })
  const toggleCategory = (category: GrammarCategory, checked: boolean): void => {
    const next = checked
      ? [...preferences.enabledCategories, category]
      : preferences.enabledCategories.filter((item) => item !== category)
    update({ enabledCategories: next })
  }
  const testConnection = async (): Promise<void> => {
    update({ endpoint: endpointDraft })
    healthController.current?.abort()
    const controller = new AbortController()
    healthController.current = controller
    setHealth({ phase: 'checking', message: 'Testing connection…' })
    try {
      const result = await probeGrammarProvider(
        { ...preferences, endpoint: endpointDraft.trim() },
        bridge,
        controller.signal
      )
      if (!controller.signal.aborted) {
        setHealth({ phase: 'reachable', message: `Reachable · ${result.latencyMs} ms` })
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        setHealth({
          phase: 'error',
          message: error instanceof Error ? error.message : 'Connection test failed.'
        })
      }
    }
  }

  return (
    <div className="space-y-6" data-settings-search-id="grammar-provider">
      <SettingsGroup
        title="Grammar assistant"
        description="Check spelling and grammar in Markdown prose with LanguageTool."
      >
        <ToggleSetting
          label="Enable grammar assistant"
          description="Local opt-in for this device. ZenNotes never checks notes until this is enabled."
          checked={grammarEnabled}
          disabled={!supported}
          onChange={setGrammarEnabled}
        />
        <div className="px-5 py-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-sm font-medium text-ink-800">LanguageTool provider</div>
              <div className="mt-1 text-xs text-ink-500">{providerStatus}</div>
            </div>
            <span
              className={[
                'rounded-full border px-2.5 py-1 text-xs font-medium',
                endpoint.scope === 'local'
                  ? 'border-emerald-500/35 bg-emerald-500/10 text-emerald-700'
                  : endpoint.scope === 'remote'
                    ? 'border-amber-500/40 bg-amber-500/10 text-amber-700'
                    : 'border-red-500/40 bg-red-500/10 text-red-700'
              ].join(' ')}
            >
              {endpoint.label}
            </span>
          </div>
          <div className="mt-3 rounded-xl border border-paper-300/60 bg-paper-100/55 px-3 py-2 text-xs leading-5 text-ink-600">
            <span className="font-medium">{endpoint.label}:</span> {endpoint.message}
          </div>
        </div>
        <label className="block px-5 py-4">
          <span className="text-sm font-medium text-ink-800">Endpoint</span>
          <input
            value={endpointDraft}
            spellCheck={false}
            onChange={(event) => {
              setEndpointDraft(event.target.value)
              setHealth({ phase: 'idle', message: 'Endpoint changed; test it again.' })
            }}
            onBlur={() => update({ endpoint: endpointDraft })}
            className="mt-2 w-full rounded-xl border border-paper-300/70 bg-paper-100 px-3 py-2 font-mono text-sm text-ink-800 outline-none focus:border-accent/55"
          />
        </label>
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
          <div className="text-xs leading-5 text-ink-500">
            The test sends only: “ZenNotes grammar connection test.”
          </div>
          <button
            type="button"
            disabled={!supported || endpoint.scope === 'invalid' || health.phase === 'checking'}
            onClick={() => void testConnection()}
            className="rounded-xl border border-paper-300/70 px-3 py-2 text-sm font-medium text-ink-700 hover:bg-paper-200 disabled:cursor-default disabled:opacity-45"
          >
            Test connection
          </button>
        </div>
      </SettingsGroup>

      <SettingsGroup
        title="Checking"
        description="Choose when checks run, the language, and which issue types appear."
      >
        <label className="flex items-center justify-between gap-4 px-5 py-4">
          <span>
            <span className="block text-sm font-medium text-ink-800">Language</span>
            <span className="mt-1 block text-xs text-ink-500">
              LanguageTool language or dialect.
            </span>
          </span>
          <span>
            <input
              list="grammar-language-options"
              value={languageDraft}
              onChange={(event) => setLanguageDraft(event.target.value)}
              onBlur={() => update({ language: languageDraft })}
              className="rounded-xl border border-paper-300/70 bg-paper-100 px-3 py-2 text-sm text-ink-800"
            />
            <datalist id="grammar-language-options">
              <option value="auto">Automatic</option>
              <option value="en-US">English (US)</option>
              <option value="en-GB">English (UK)</option>
              <option value="en-CA">English (Canada)</option>
              <option value="en-AU">English (Australia)</option>
            </datalist>
          </span>
        </label>
        <ToggleSetting
          label="Automatic checks"
          description="Check changed prose after typing pauses. Manual Recheck remains available when off."
          checked={preferences.automaticChecks}
          onChange={(automaticChecks) => update({ automaticChecks })}
        />
        <label className="flex items-center justify-between gap-4 px-5 py-4">
          <span>
            <span className="block text-sm font-medium text-ink-800">Typing pause</span>
            <span className="mt-1 block text-xs text-ink-500">
              250–5000 ms before an automatic check.
            </span>
          </span>
          <input
            type="number"
            min={250}
            max={5000}
            step={50}
            value={preferences.debounceMs}
            onChange={(event) => update({ debounceMs: Number(event.target.value) })}
            className="w-28 rounded-xl border border-paper-300/70 bg-paper-100 px-3 py-2 text-right text-sm text-ink-800"
          />
        </label>
        {GRAMMAR_CATEGORIES.map((category) => (
          <ToggleSetting
            key={category}
            label={categoryLabel(category)}
            description={`Show ${category} findings in the editor and review panel.`}
            checked={preferences.enabledCategories.includes(category)}
            onChange={(checked) => toggleCategory(category, checked)}
          />
        ))}
      </SettingsGroup>

      <SettingsGroup
        title="Markdown regions"
        description="Code, frontmatter, URLs, math, and hidden Markdown are always excluded."
      >
        {(
          [
            ['checkHeadings', 'Headings'],
            ['checkLists', 'Lists and tasks'],
            ['checkBlockquotes', 'Blockquotes and callouts'],
            ['checkTables', 'Table cells'],
            ['checkLinkLabels', 'Link labels and wiki aliases']
          ] as const
        ).map(([field, label]) => (
          <ToggleSetting
            key={field}
            label={label}
            description={`Include ${label.toLocaleLowerCase()} in grammar checks.`}
            checked={preferences[field]}
            onChange={(checked) => update({ [field]: checked })}
          />
        ))}
      </SettingsGroup>

      <SettingsGroup
        title="Personalization"
        description="These lists stay in ZenNotes. Dictionary entries are filtered locally."
      >
        <label className="block px-5 py-4">
          <span className="text-sm font-medium text-ink-800">Ignored rule IDs</span>
          <span className="mt-1 block text-xs leading-5 text-ink-500">
            One LanguageTool rule ID per line.
          </span>
          <textarea
            rows={5}
            value={rulesDraft}
            onChange={(event) => setRulesDraft(event.target.value)}
            onBlur={() => commitLines('ignoredRules', rulesDraft)}
            className="mt-2 w-full resize-y rounded-xl border border-paper-300/70 bg-paper-100 px-3 py-2 font-mono text-sm text-ink-800 outline-none focus:border-accent/55"
          />
        </label>
        <label className="block px-5 py-4">
          <span className="text-sm font-medium text-ink-800">Custom dictionary</span>
          <span className="mt-1 block text-xs leading-5 text-ink-500">
            One accepted word or exact phrase per line.
          </span>
          <textarea
            rows={6}
            value={dictionaryDraft}
            onChange={(event) => setDictionaryDraft(event.target.value)}
            onBlur={() => commitLines('customDictionary', dictionaryDraft)}
            className="mt-2 w-full resize-y rounded-xl border border-paper-300/70 bg-paper-100 px-3 py-2 font-mono text-sm text-ink-800 outline-none focus:border-accent/55"
          />
        </label>
      </SettingsGroup>

      <SettingsGroup
        title="Display and diagnostics"
        description="Control editor marks and privacy-safe troubleshooting output."
      >
        <ToggleSetting
          label="Show editor underlines"
          description="Keep the review panel active while hiding inline marks when off."
          checked={preferences.showUnderlines}
          onChange={(showUnderlines) => update({ showUnderlines })}
        />
        <ToggleSetting
          label="Diagnostic logging"
          description="Log status and issue counts only. Note text and note paths are never logged."
          checked={preferences.diagnosticLogging}
          onChange={(diagnosticLogging) => update({ diagnosticLogging })}
        />
        <div className="flex justify-end px-5 py-4">
          <button
            type="button"
            onClick={() => setPreferences(DEFAULT_GRAMMAR_PREFERENCES)}
            className="rounded-xl border border-paper-300/70 px-3 py-2 text-sm font-medium text-ink-700 hover:bg-paper-200"
          >
            Restore grammar defaults
          </button>
        </div>
      </SettingsGroup>
    </div>
  )
}
