const RISK_VIS: Record<string, { label: string; emoji: string }> = {
  low: { label: 'LOW', emoji: '🟢' },
  medium: { label: 'MEDIUM', emoji: '🟡' },
  high: { label: 'HIGH', emoji: '🔴' },
}

export function RiskBadge({ level }: { level: string }) {
  const v = RISK_VIS[level] ?? {
    label: level.toUpperCase(),
    emoji: '⚪',
  }
  return (
    <span className="risk-badge" title={level}>
      Risk: <strong>{v.label}</strong> {v.emoji}
    </span>
  )
}

export function riskShort(level: string) {
  const v = RISK_VIS[level] ?? {
    label: level.toUpperCase(),
    emoji: '⚪',
  }
  return `${v.label} ${v.emoji}`
}
