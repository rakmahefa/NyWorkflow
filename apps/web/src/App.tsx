import { APP_NAME, APP_VERSION } from './lib/version'

/**
 * M0 placeholder. M1 (see MILESTONES.md) replaces this with the real
 * harness UI: sessions sidebar, chat area, /commands.
 */
export default function App() {
  return (
    <main style={{ fontFamily: 'system-ui', padding: '2rem' }}>
      <h1>{APP_NAME}</h1>
      <p>Harness web ICM — l&rsquo;UI arrive au M1 (voir MILESTONES.md).</p>
      <small>v{APP_VERSION}</small>
    </main>
  )
}
