/**
 * Journal amont — les derniers tours vus par la passerelle, en mémoire (tampon
 * circulaire, jamais écrit sur disque) : le panneau Paramètres de l'UI affiche
 * « les derniers échecs typés » sans devoir fouiller des logs.
 *
 * Volontairement minuscule : pas de niveau, pas de transport — juste l'utile
 * pour diagnostiquer (modèle, compte, durée, tentative, erreur typée).
 */
export interface TurnRecord {
  /** ISO 8601 — début du tour. */
  at: string
  model: string
  ok: boolean
  /** Nombre de tentatives HTTP amont (retries inclus). */
  attempts: number
  /** Durée totale du tour, ms. */
  ms: number
  /** Compte cookie utilisé (index dans la rotation), le cas échéant. */
  account?: number
  error?: { kind: string; message: string; status?: number }
}

export const DEFAULT_JOURNAL_CAPACITY = 50

export class TurnJournal {
  private readonly capacity: number
  private readonly entries: TurnRecord[] = []
  /** M13 — optional sink: every recorded turn also lands here (engine log). */
  private readonly onRecord?: (entry: TurnRecord) => void

  constructor(capacity: number = DEFAULT_JOURNAL_CAPACITY, onRecord?: (entry: TurnRecord) => void) {
    this.capacity = Math.max(1, capacity)
    this.onRecord = onRecord
  }

  record(entry: TurnRecord): void {
    this.entries.push(entry)
    if (this.entries.length > this.capacity) this.entries.splice(0, this.entries.length - this.capacity)
    this.onRecord?.(entry)
  }

  /** Les plus récents en dernier — copie défensive. */
  recent(): readonly TurnRecord[] {
    return [...this.entries]
  }

  /** M9 — statistiques d'utilisation par compte, sur la fenêtre du journal. */
  usage(): AccountUsage[] {
    return accountUsage(this.entries)
  }
}

/**
 * M9 — statistiques d'utilisation par compte : tours, réussites, échecs,
 * durée cumulée, dernier tour. Les enregistrements sans compte (jamais
 * arrivés jusqu'à la rotation) sont ignorés. Tri par index de compte.
 */
export interface AccountUsage {
  account: number
  turns: number
  ok: number
  failed: number
  /** ISO 8601 du DERNIER tour de ce compte. */
  lastAt?: string
  /** Durée cumulée des tours du compte, ms. */
  totalMs: number
}

/** Agrège des tours (déjà dans l'ordre chronologique) par compte. */
export function accountUsage(records: readonly TurnRecord[]): AccountUsage[] {
  const byAccount = new Map<number, AccountUsage>()
  for (const r of records) {
    if (r.account === undefined) continue
    let usage = byAccount.get(r.account)
    if (usage === undefined) {
      usage = { account: r.account, turns: 0, ok: 0, failed: 0, totalMs: 0 }
      byAccount.set(r.account, usage)
    }
    usage.turns++
    usage.totalMs += r.ms
    if (r.ok) usage.ok++
    else usage.failed++
    usage.lastAt = r.at // les enregistrements sont chronologiques
  }
  return [...byAccount.values()].sort((a, b) => a.account - b.account)
}
