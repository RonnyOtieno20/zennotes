import { SettingsSwitch } from './SettingsSwitch'
import '../grammar/ui.css'
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

const DEBOUNCE_MIN_MS = 250
const DEBOUNCE_MAX_MS = 5000

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
    <label className="grammar-settings-row">
      <span>
        <span className="block text-sm font-medium text-ink-800">{label}</span>
        <span className="mt-1 block text-xs leading-5 text-ink-500">{description}</span>
      </span>
      <SettingsSwitch value={checked} disabled={disabled} onChange={onChange} label={label} />
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
    <section className="grammar-settings-group">
      <div>
        <h3 className="grammar-settings-title">{title}</h3>
        <p className="mt-1 max-w-2xl text-sm leading-6 text-ink-500">{description}</p>
      </div>
      <div className="grammar-settings-rows">
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
  const [debounceDraft, setDebounceDraft] = useState(String(preferences.debounceMs))
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
  useEffect(() => setDebounceDraft(String(preferences.debounceMs)), [preferences.debounceMs])
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
  // Typing is only a draft. Commit on blur or Enter: clamp to the range, and revert unreadable input.
  const commitDebounce = (value: string): void => {
    const parsed = Number(value.trim())
    if (value.trim() === '' || !Number.isFinite(parsed)) {
      setDebounceDraft(String(preferences.debounceMs))
      return
    }
    const debounceMs = Math.min(DEBOUNCE_MAX_MS, Math.max(DEBOUNCE_MIN_MS, Math.round(parsed)))
    setDebounceDraft(String(debounceMs))
    if (debounceMs !== preferences.debounceMs) update({ debounceMs })
  }
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
    <div className="grammar-ui grammar-settings" data-settings-search-id="grammar-provider">
      <div className="grammar-settings-master grammar-settings-rows">
        <ToggleSetting
          label="Enable grammar assistant"
          description={!grammarEnabled
            ? 'Off. Turn on to underline mistakes as you write.'
            : endpoint.scope === 'local'
              ? 'On. LanguageTool checks your notes on this device.'
              : 'On. Note text is sent to your LanguageTool server.'}
          checked={grammarEnabled}
          disabled={!supported}
          onChange={setGrammarEnabled}
        />
      </div>
      <SettingsGroup
        title="LanguageTool"
        description="Use your own LanguageTool server. Your notes only go to the address you choose."
      >
        <div className="px-5 py-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-sm font-medium text-ink-800">LanguageTool provider</div>
              <div role="status" className="mt-1 text-xs text-ink-500">{providerStatus}</div>
            </div>
            <span className="grammar-settings-status" data-scope={endpoint.scope}>
              {endpoint.label}
            </span>
          </div>
          <div className="grammar-settings-notice">
            <span className="font-medium">{endpoint.label}:</span> {endpoint.message}
          </div>
        </div>
        <label className="block px-5 py-4">
          <span className="text-sm font-medium text-ink-800">Server address</span>
          <span className="mt-1 block text-xs leading-5 text-ink-500">Start your server, enter its full URL (including /v2), then test the connection.</span>
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
            className="grammar-settings-test"
          >
            Test connection
          </button>
        </div>
      </SettingsGroup>

      <SettingsGroup
        title="Checking"
        description="Choose your language and when suggestions appear."
      >
        <label className="grammar-settings-row">
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
        <label className="grammar-settings-row">
          <span>
            <span className="block text-sm font-medium text-ink-800">Typing pause</span>
            <span className="mt-1 block text-xs text-ink-500">
              250–5000 ms before an automatic check.
            </span>
          </span>
          <input
            type="number"
            min={DEBOUNCE_MIN_MS}
            max={DEBOUNCE_MAX_MS}
            step={50}
            value={debounceDraft}
            onChange={(event) => setDebounceDraft(event.target.value)}
            onBlur={(event) => commitDebounce(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commitDebounce(event.currentTarget.value)
              // Cancel the edit here, so Escape does not also close the settings dialog.
              if (event.key === 'Escape') {
                event.stopPropagation()
                setDebounceDraft(String(preferences.debounceMs))
              }
            }}
            className="w-28 rounded-xl border border-paper-300/70 bg-paper-100 px-3 py-2 text-right text-sm text-ink-800"
          />
        </label>
      </SettingsGroup>

      <SettingsGroup
        title="Suggestion types"
        description="Keep the feedback you find useful. Colours match the marks in your note."
      >
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
        description="Choose Add to dictionary on a spelling issue, or Ignore to skip one finding. Manage your saved words and rules here."
      >
        <label className="block px-5 py-4">
          <span className="text-sm font-medium text-ink-800">Ignored rule IDs</span>
          <span className="mt-1 block text-xs leading-5 text-ink-500">
            One LanguageTool rule ID per line, ignored in every note. To ignore a rule in one note
            only, list it in that note&rsquo;s front matter as{' '}
            <code className="font-mono">grammar-ignore: [RULE_ID]</code>.
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
