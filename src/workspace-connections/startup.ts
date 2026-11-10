import type { WorkspaceConnections } from './config.js'

/** Optional OAuth configuration must not stop unrelated Team Space services. */
export function initializeWorkspaceConnections(
  configure: () => WorkspaceConnections | null,
  reportDisabled: (message: string) => void,
): WorkspaceConnections | null {
  try {
    return configure()
  } catch {
    // Provider/OS diagnostics can contain credentials or private paths.
    reportDisabled('[bridge] Self-hosted Connections disabled: check Connections OAuth configuration and TEAMSPACE_AT_REST_KEY')
    return null
  }
}
