import { expect, it } from 'vitest'
import * as shared from '../../../shared/config-file'
import * as config from './config-file'
import * as routes from '../routes/feature-config-support'

it('keeps configuration and route support exports on the shared discovery owner', () => {
  expect(config.FEATURE_CONFIG_NAMES).toBe(shared.FEATURE_CONFIG_NAMES)
  expect(config.findExistingConfig).toBe(shared.findExistingConfig)
  expect(routes.FEATURE_CONFIG_NAMES).toBe(shared.FEATURE_CONFIG_NAMES)
  expect(routes.findExistingConfig).toBe(shared.findExistingConfig)
})
