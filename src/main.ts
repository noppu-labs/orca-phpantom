import type { OrcaWorkerApi } from 'orca/worker'
import './protocol.ts'
import { aggregate, renderStatus } from './status.ts'

export default async function activate(orca: OrcaWorkerApi): Promise<void> {
  const update = renderStatus(aggregate([]))
  await orca.host.call('statusBar.update', update)

  orca.commands.register('phpantom.status', () => update.tooltip)
  orca.commands.register('phpantom.restart', () => 'Nothing to restart')
}
