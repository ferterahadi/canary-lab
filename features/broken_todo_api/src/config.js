const { loadFeatureEnv } = require('canary-lab/feature-support/load-env')

loadFeatureEnv(__dirname + '/..')

const GATEWAY_URL = process.env.GATEWAY_URL ?? 'http://localhost:4100'

module.exports = {
  GATEWAY_URL,
}
