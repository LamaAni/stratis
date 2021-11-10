const { StratisOAuth2Provider } = require('./oauth2.js')
const express = require('express')
const cookie_session = require('cookie-session')
const path = require('path')

const TEST_TOKEN_URL = process.env['TEST_OAUTH2_TOKEN_URL']
const TEST_AUTH_URL = process.env['TEST_OAUTH2_AUTH_URL'] || TEST_TOKEN_URL
const TEST_CLIENT_ID = process.env['TEST_OAUTH2_CLIENT_ID']
const TEST_CLIENT_SECRET = process.env['TEST_OAUTH2_CLIENT_SECRET']

const app = express()

app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store')
  console.log(req.url)
  return next()
})

app.use(
  cookie_session({
    secure: false,
    name: path.basename(__filename),
    keys: [path.basename(__filename)],
  })
)

new StratisOAuth2Provider({
  token_url: TEST_TOKEN_URL,
  authorize_url: TEST_AUTH_URL,
  client_id: TEST_CLIENT_ID,
  client_secret: TEST_CLIENT_SECRET,
  scope: ['okta.users.read.self'],
}).apply(app)

app.use((req, res, next) => {
  res.send('OK!')
})

app.listen(8080, () => {
  console.log('listening on port 8080')
})