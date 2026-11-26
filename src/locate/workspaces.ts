import { existsSync } from 'node:fs'
import { dirname, sep } from 'node:path'

/** The fields of a `workspace.list` row this plugin uses. */
export type WorkspaceRow = { id: string; name: string; branch: string | null; path: string; hostId: string | null }

const WSL_PATH = /^(\\\\|\/\/)wsl(\.localhost|\$)[\\/]/i

/** A workspace on this machine: host `local` or none recorded, and not a WSL share. */
export function isLocal(row: WorkspaceRow): boolean {
  return (row.hostId === 'local' || row.hostId === null) && !WSL_PATH.test(row.path)
}

/**
 * The focused workspace's row: by id, else by branch and name when exactly one row has both
 * (the pair is not unique in practice: several worktrees share main/main).
 */
export function resolveFocused(
  rows: WorkspaceRow[],
  workspaceId: string | null,
  context?: { branch: string; displayName: string }
): WorkspaceRow | null {
  if (workspaceId !== null) {
    const byId = rows.find((row) => row.id === workspaceId)
    if (byId) {
      return byId
    }
  }
  if (!context) {
    return null
  }
  const same = rows.filter((row) => row.branch === context.branch && row.name === context.displayName)
  return same.length === 1 ? same[0] : null
}

function contains(root: string, path: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) || root.endsWith('/') ? root : root + sep) || path.startsWith(root + '/')
}

/** The nearest folder at or above the file, and at or below the workspace, holding composer.json. */
export function composerRoot(filePath: string, workspacePath: string, exists: (path: string) => boolean = existsSync): string {
  let directory = dirname(filePath)
  while (contains(workspacePath, directory)) {
    const candidate = directory.endsWith(sep) ? directory : directory + sep
    if (exists(candidate + 'composer.json')) {
      return directory
    }
    const parent = dirname(directory)
    if (parent === directory || directory === workspacePath) {
      break
    }
    directory = parent
  }
  return workspacePath
}

/** The local row with the longest path that contains the file. */
export function workspaceFor(filePath: string, rows: WorkspaceRow[]): WorkspaceRow | null {
  let best: WorkspaceRow | null = null
  for (const row of rows) {
    if (isLocal(row) && contains(row.path, filePath) && (!best || row.path.length > best.path.length)) {
      best = row
    }
  }
  return best
}
