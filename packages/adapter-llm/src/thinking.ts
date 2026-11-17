/**
 * The two-phase response protocol parser (M15) — model-agnostic thinking.
 *
 * The harness teaches every model the SAME protocol (ICM system prompt):
 * a response starts with its internal dialogue wrapped in a titled tag,
 * then switches out of it for the visible work:
 *
 *   <thinking title="Comprendre la demande">
 *   … the model's internal dialogue …
 *   </thinking>
 *   The visible work (prose and/or tool calls).
 *
 * This module splits a STREAM of content deltas accordingly — incremental,
 * never losing a byte: anything that is not a valid thinking tag is text.
 * Works with any model that can emit text (native reasoning_content stays
 * a separate channel; the two coexist).
 */

/** One parsed piece of the stream: visible text, or thinking dialogue. */
export interface ThinkingPiece {
  kind: 'text' | 'thinking'
  delta: string
  /** Set ONCE, on the first piece of a thinking block — its title ('' when the tag carries none). */
  title?: string
}

/** The opening tag, as taught by the ICM prompt. */
const OPEN_TAG = '<thinking'
const CLOSE_TAG = '</thinking>'
/** One thinking block may not grow without bound — a runaway model stays honest. */
export const THINKING_TAG_MAX = 262_144

/** Parses the attributes of an opening tag: `title="…"` (or single quotes). */
export function parseTagTitle(attrs: string): string {
  const m = attrs.match(/title\s*=\s*"([^"]*)"/) ?? attrs.match(/title\s*=\s*'([^']*)'/)
  return m === null ? '' : m[1]!.slice(0, 200).trim()
}

/** The longest suffix of s that is a proper prefix of marker. */
function heldPrefix(s: string, marker: string): number {
  const max = Math.min(s.length, marker.length - 1)
  for (let len = max; len > 0; len--) {
    if (s.slice(s.length - len) === marker.slice(0, len)) return len
  }
  return 0
}

/**
 * Streaming splitter: feed it content deltas, it yields the pieces — text
 * outside the tags, thinking inside, each block opening with its title.
 * A partial tag at a chunk boundary is held back until it resolves; an
 * unclosed block at the end of the stream is auto-closed (the dialogue is
 * still thinking, never leaked as visible text).
 */
export class ThinkingSplitter {
  private mode: 'text' | 'thinking' = 'text'
  /** Held-back tail: a potential partial opening/closing tag. */
  private buf = ''
  /** Chars of thinking emitted for the CURRENT block (the runaway cap). */
  private blockChars = 0

  /** One content delta in; the parsed pieces out (may be empty — all buffered). */
  push(delta: string): ThinkingPiece[] {
    if (delta.length === 0) return []
    this.buf += delta
    return this.mode === 'text' ? this.pumpText() : this.pumpThinking()
  }

  /** End of stream: flush the held-back tail (a stray partial tag is text). */
  finish(): ThinkingPiece[] {
    const tail = this.buf
    this.buf = ''
    if (tail.length === 0) return []
    // An unterminated <thinking head at the very end is prose, an
    // unterminated block is still dialogue — auto-closed, never leaked.
    return [{ kind: this.mode === 'text' ? 'text' : 'thinking', delta: tail }]
  }

  private pumpText(): ThinkingPiece[] {
    const out: ThinkingPiece[] = []
    let s = this.buf
    for (let guard = 0; ; guard++) {
      if (guard > 10_000) break // theoretical guard — every pass consumes
      const idx = s.indexOf(OPEN_TAG)
      if (idx < 0) break
      const after = s.slice(idx + OPEN_TAG.length)
      const gt = after.indexOf('>')
      if (gt < 0) {
        // Incomplete head. Absurdly long without '>' → prose, keep scanning.
        if (after.length > 200) {
          out.push({ kind: 'text', delta: s.slice(0, idx + OPEN_TAG.length) })
          s = after
          continue
        }
        // Hold from the '<' — the text before it is already visible work.
        if (idx > 0) out.push({ kind: 'text', delta: s.slice(0, idx) })
        this.buf = s.slice(idx)
        return out
      }
      // '<thinking' must be followed by whitespace or '>' — else it is prose.
      const first = after[0] ?? ''
      if (first !== '>' && !/\s/.test(first)) {
        out.push({ kind: 'text', delta: s.slice(0, idx + OPEN_TAG.length) })
        s = after
        continue
      }
      const title = parseTagTitle(after.slice(0, gt))
      if (idx > 0) out.push({ kind: 'text', delta: s.slice(0, idx) })
      out.push({ kind: 'thinking', delta: '', title })
      this.mode = 'thinking'
      this.blockChars = 0
      s = after.slice(gt + 1)
      this.buf = s
      out.push(...this.pumpThinking())
      return out
    }
    // Hold a potential partial tag; the rest is visible text.
    const hold = heldPrefix(s, OPEN_TAG)
    this.buf = hold > 0 ? s.slice(s.length - hold) : ''
    const keep = hold > 0 ? s.slice(0, s.length - hold) : s
    if (keep.length > 0) out.push({ kind: 'text', delta: keep })
    return out
  }

  private pumpThinking(): ThinkingPiece[] {
    const out: ThinkingPiece[] = []
    let s = this.buf
    for (let guard = 0; ; guard++) {
      if (guard > 10_000) break
      const idx = s.indexOf(CLOSE_TAG)
      if (idx < 0) break
      this.emitThinking(out, s.slice(0, idx))
      this.mode = 'text'
      this.blockChars = 0
      s = s.slice(idx + CLOSE_TAG.length)
      this.buf = s
      out.push(...this.pumpText())
      return out
    }
    // Hold a potential partial closing tag; the rest is dialogue.
    const hold = heldPrefix(s, CLOSE_TAG)
    this.buf = hold > 0 ? s.slice(s.length - hold) : ''
    const keep = hold > 0 ? s.slice(0, s.length - hold) : s
    this.emitThinking(out, keep)
    return out
  }

  /** Emits thinking under the per-block cap; over cap, the block closes itself. */
  private emitThinking(out: ThinkingPiece[], chunk: string): void {
    if (chunk.length === 0) return
    const room = THINKING_TAG_MAX - this.blockChars
    if (room <= 0) {
      this.mode = 'text'
      this.blockChars = 0
      this.buf = ''
      return
    }
    out.push({ kind: 'thinking', delta: chunk.slice(0, room) })
    this.blockChars += Math.min(chunk.length, room)
    if (chunk.length > room) {
      // Over cap: the rest of the block is dropped, the mode returns to text.
      this.mode = 'text'
      this.blockChars = 0
      this.buf = ''
    }
  }
}
