import { expect, it } from 'vitest'
import { childPlatformEnvironment } from '../src/dsh'

it('copies platform paths and locale without mutating the caller environment', () => {
  const platform = {
    Path: '/bin',
    PATHEXT: '.EXE',
    SystemRoot: 'C:/Windows',
    WINDIR: 'C:/Windows',
    COMSPEC: 'cmd',
    HOME: '/home/service',
    USERPROFILE: 'C:/user',
    APPDATA: '/app',
    LOCALAPPDATA: '/local',
    TEMP: '/temp',
    TMP: '/tmp',
    TMPDIR: '/tmpdir',
    LANG: 'ru_RU',
    LC_ALL: 'ru_RU',
    TZ: 'UTC',
    NODE_ENV: 'production',
    NODE_EXTRA_CA_CERTS: '/ca',
    SSL_CERT_FILE: '/cert',
    SSL_CERT_DIR: '/certs',
  }
  const result = childPlatformEnvironment(platform)
  expect(result).toEqual(platform)
  result.Path = 'changed'
  expect(platform.Path).toBe('/bin')
})

it('excludes parent credentials, provider config and executable preload hooks', () => {
  expect(
    childPlatformEnvironment({
      AI37_NPM_TOKEN: 'secret',
      AUTHORIZATION: 'secret',
      DATABASE_URL: 'secret',
      BILLING_BASE_URL: 'secret',
      OPENAI_API_KEY: 'secret',
      DEEPSEEK_API_KEY: 'secret',
      LLM_BASE_URL: 'secret',
      LLM_KEY: 'secret',
      SEARCH_REQUEST_BRIDGE_SECRET: 'secret',
      NODE_OPTIONS: '--import secret',
      NODE_PATH: '/private/modules',
      OTHER: 'value',
    }),
  ).toEqual({})
  expect(childPlatformEnvironment({})).toEqual({})
})
