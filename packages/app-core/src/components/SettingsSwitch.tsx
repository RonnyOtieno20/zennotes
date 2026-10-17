/** Native settings switch, shared by Harper and LanguageTool. */
export function SettingsSwitch({
  value,
  onChange,
  disabled,
  label
}: {
  value: boolean
  onChange(value: boolean): void
  disabled?: boolean
  label: string
}): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={value}
      disabled={disabled}
      onClick={() => onChange(!value)}
      className={[
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:cursor-default disabled:opacity-45',
        value ? 'bg-accent' : 'bg-paper-300'
      ].join(' ')}
    >
      <span
        className={[
          'inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform',
          value ? 'translate-x-4' : 'translate-x-0.5'
        ].join(' ')}
      />
    </button>
  )
}
