// Adapted from actus7/orca-autocomplete editor/src/main.ts @ da5a680 (MIT). See THIRD_PARTY_NOTICES.md.
// The bundle's entry: start the editor, or say on the page why it could not start.
import { startEditor } from './editor.ts'

startEditor().catch((error: unknown) => {
  // Orca copies frame errors into the plugin's log; also say it on screen so the tab is not blank.
  console.error(error)
  const failure = document.createElement('div')
  failure.className = 'start-failed'
  failure.setAttribute('role', 'alert')
  const title = document.createElement('strong')
  title.textContent = 'The PHPantom editor could not start.'
  const detail = document.createElement('span')
  detail.textContent = error instanceof Error ? error.message : String(error)
  failure.append(title, detail)
  document.getElementById('root')?.replaceChildren(failure)
})
