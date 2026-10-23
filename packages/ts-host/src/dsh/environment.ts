const PLATFORM_ENVIRONMENT = new Set([
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'TEMP',
  'TMP',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'TZ',
  'NODE_ENV',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
])

/**
 * Copy OS paths/locale only, matching Windows environment names case-insensitively.
 * Callers add their explicit runtime configuration to the result.
 * Parent provider, billing, auth, database and Node preload variables stay out.
 */
export function childPlatformEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(environment).filter(([name]) => PLATFORM_ENVIRONMENT.has(name.toUpperCase())),
  )
}
