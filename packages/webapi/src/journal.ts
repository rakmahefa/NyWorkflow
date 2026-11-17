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

  constructor(capacity: number = DEFAULT_JOURNAL_CAPACITY) {
    this.capacity = Math.max(1, capacity)
  }

  record(entry: TurnRecord): void {
    this.entries.push(entry)
    if (this.entries.length > this.capacity) this.entries.splice(0, this.entries.length - this.capacity)
  }

  /** Les plus récents en dernier — copie défensive. */
  recent(): readonly TurnRecord[] {
    return [...this.entries]
  }
}
