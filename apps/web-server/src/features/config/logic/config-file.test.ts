import { expect, it } from 'vitest'
import * as shared from '../../../shared/config-file'
import * as configConfigFile from '../../../shared/config-file'
import * as routesConfigFile from '../../../shared/config-file'

it('keeps configuration and route support exports on the shared discovery owner', () => {
  expect(configConfigFile.FEATURE_CONFIG_NAMES).toBe(shared.FEATURE_CONFIG_NAMES)
  expect(configConfigFile.findExistingConfig).toBe(shared.findExistingConfig)
  expect(routesConfigFile.FEATURE_CONFIG_NAMES).toBe(shared.FEATURE_CONFIG_NAMES)
  expect(routesConfigFile.findExistingConfig).toBe(shared.findExistingConfig)
})
