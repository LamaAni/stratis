const {
  milliseconds_utc_since_epoc,
  value_from_object_path,
} = require('../../common')

const { parse_bearer_token } = require('./common')

/**
 * @typedef {import('express').Request} Request
 * @typedef {import('express').Response} Response
 * @typedef {import('./provider').StratisOAuth2Provider} StratisOAuth2Provider
 */

/**
 * @typedef {Object} StratisOAuth2ProviderSessionData
 * @property {string} access_token The access token.
 * @property {string} id_token The id token.
 * @property {string} scope The session scope.
 * @property {string} refresh_token The refresh token
 * @property {{}} token_info The downloaded introspect token info
 * @property {number} invalidated The timestamp for which the current tokens were invalidated.
 * @property {number} updated The timestamp of the last session data update.
 * @property {number} refreshed The timestamp of the last session refresh token call.
 * @property {number} introspected The timestamp of the last token info update.
 */

class StratisOAuth2ProviderSession {
  /**
   * The current session for the stratis authentication provider.
   * @param {StratisOAuth2Provider} provider
   * @param {Request} req the http request
   */
  constructor(provider, req) {
    this._provider = provider
    this._req = req

    /**
     * The session data that can be saved and loaded from the session state
     * @type {StratisOAuth2ProviderSessionData} */
    this._data = {}

    /** @type {'session_state'|'bearer'} Where the token was loaded from. */
    this.session_type = null
  }

  /** The OAuth provider */
  get provider() {
    return this._provider
  }

  /** The associated request */
  get req() {
    return this._req
  }

  /** The session storable data */
  get data() {
    if (this._data == null) this._data = {}
    return this._data
  }

  /** @type {string} The session id token if any */
  get id_token() {
    return this.data.id_token
  }

  /**
   * @type {string} The session access token if any
   */
  get access_token() {
    return this.data.access_token
  }

  /**
   * @type {string} The session refresh token.
   */
  get refresh_token() {
    return this.data.refresh_token
  }

  /**
   * The timestamp (utc) of the last token update.
   */
  get updated() {
    return this.data.updated || 0
  }

  /**
   * The last time the refresh token was updated.
   */
  get refreshed() {
    return this.data.refreshed || 0
  }

  /**
   * The last time the token was introspected.
   */
  get introspected() {
    return this.data.introspected || 0
  }

  /**
   * The timestamp of when the token(s) were invalidated.
   */
  get invalidated() {
    return this.data.invalidated
  }

  /**
   * The introspection downloaded token info (Provider specific)
   */
  get token_info() {
    return this.data.token_info || {}
  }

  /**
   * If false, then the current session has been invalidated.
   * A refresh token can then be called.
   */
  get active() {
    if (this.data.token_info == null) return true
    return this.token_info.active == true
  }

  /**
   * The last 5 chars of the active token.
   */
  get session_id() {
    const token = this.access_token || this.id_token
    return token == null || token.length < 5
      ? '?????'
      : token.substring(token.length - 5)
  }

  /**
   * @type {string} The associated username extracted from the token info.
   * The token info path can be set in the provider: username_from_token_info_path
   */
  get username() {
    if (this.data == null || this.data.token_info == null) return 'Anonymous'
    if (this.data.token_info._username == null) {
      this.token_info._username =
        this.provider.username_from_token_info_path
          .map((p) => value_from_object_path(this.data.token_info, p))
          .filter((v) => v != null)[0] || 'Anonymous'
    }
    return this.data.token_info._username
  }

  is_valid_session() {
    if (this.access_token == null) return false
    if (this.session_type == 'bearer') return true
    return this.data.invalidated == null
  }

  is_valid_token_info() {
    if (this.provider.requests.introspect_url == null) return true
    return this.data.token_info != null
  }

  is_refresh_elapsed() {
    // cannot use refresh on bearer token
    if (this.session_type == 'bearer') return false
    // Not refresh token it cannot elapse.
    if (this.refresh_token == null) return false

    return (
      milliseconds_utc_since_epoc() - this.refreshed >=
      this.provider.refresh_interval
    )
  }

  is_recheck_elapsed() {
    return (
      milliseconds_utc_since_epoc() - this.updated >=
      this.provider.recheck_interval
    )
  }

  is_authenticated() {
    return this.is_valid_session() && !this.needs_update()
  }

  needs_update() {
    if (!this.is_valid_session()) return false

    return (
      !this.active ||
      !this.is_valid_token_info() ||
      this.is_recheck_elapsed() ||
      this.is_refresh_elapsed()
    )
  }

  /**
   * Mark the current session is invalid.
   */
  invalidate() {
    this.data.invalidated = milliseconds_utc_since_epoc()
  }

  /**
   * Update the session info using the api response
   * @param {StratisOAuth2ProviderSessionData} data
   */
  async update_session_data(data, save = true) {
    Object.entries(data)
      .filter((e) => e[1] != null)
      .forEach((e) => {
        this.data[e[0]] = e[1]
      })

    // updating timestamps.
    this.data.updated = milliseconds_utc_since_epoc()
    if (data.refresh_token != null)
      this.data.refreshed = milliseconds_utc_since_epoc()

    // if there was an access token, then we need
    // to remove invalidation if any.
    if (data.access_token) delete this.data.invalidated

    if (save) await this.save()
  }

  /**
   * Call to update the token info.
   * @param {boolean} save Save the new state to the session.
   * @param {boolean} throw_errors Throw any download token errors.
   * @returns True if successful update or no need.
   */
  async update_token_info(save = true, throw_errors = true) {
    if (this.provider.requests.introspect_url == null) return true

    let token_info = null
    try {
      token_info = await this.provider.requests.introspect(
        this.access_token,
        'access_token'
      )
    } catch (err) {
      if (throw_errors) throw err
      return false
    }

    await this.update_session_data({ token_info }, save)

    return true
  }

  /**
   * Call to refresh the tokens.
   * @param {boolean} save Save the new state to the session
   * @param {boolean} throw_errors Throw any download token errors.
   * @returns True if successful updated
   */
  async refresh(save = true, throw_errors = true) {
    // no refresh token
    if (this.refresh_token == null) return false

    // refresh response can fail, since the refresh token may be invalid.
    let session_data = null
    try {
      session_data = await this.provider.requests.get_token_from_refresh_token(
        this.refresh_token
      )
    } catch (err) {
      if (throw_errors) throw err
      return false
    }

    await this.update_session_data(session_data, save)

    return true
  }

  /**
   * Sends a request to the service for updating the session info
   * if needs updated.
   * @param {boolean} force If true then force the update.
   */
  async update(force = false) {
    // nothing to do. No access token.
    if (!this.is_valid_session()) return false

    // Dont update if not needed
    if (!force && !this.needs_update()) return false

    let update_type = 'Introspect'

    switch (this.session_type) {
      case 'bearer':
        // bearer token update is just introspect.
        await this.update_token_info(false, false)
        if (!this.active) this.invalidate()
      case 'session_state':
        // If no refresh is needed then we will attempt to just
        // update the session token info. Otherwise
        // do a full refresh.
        let needs_refresh = this.is_refresh_elapsed() || !this.active

        if (!needs_refresh) {
          if (!(await this.update_token_info(false, false)))
            // the case where the token introspect failed.
            needs_refresh = true
          // the case where after the token introspect, the session is not active.
          else {
            needs_refresh = !this.active
          }
        }

        if (needs_refresh)
          if (
            this.session_type == 'bearer' ||
            !(await this.refresh(false, false))
          ) {
            // session was invalidated. The access tokens are not valid anymore.
            // and the token data is not valid.
            this.invalidate()
          } else {
            update_type = 'Refresh'

            // need to retry to update the token info after refresh.
            // since we have new refresh token info.
            if (!(await this.update_token_info(false, false)))
              this.provider.logger.warn(
                'Refresh token retrieved but token_info could not be retrieved.' +
                  ' Error in refresh token return values'
              )
          }

        break
    }

    await this.save()

    this.provider.logger.debug(
      `Access ${
        this.is_authenticated() ? 'GRANTED'.green.reset : 'DENIED'.red.reset
      }` +
        ` for ${this.username} (TID: ${this.session_id}, via ${update_type})`
          .gray
    )

    return true
  }

  /**
   * Loads the oauth session data from req.session
   * @param {{}} session
   */
  async load_data_from_session(session) {
    const session_value = (session || {})[this.provider.session_key] || {}
    this._data =
      typeof session_value == 'string'
        ? JSON.parse(session_value)
        : session_value

    this.session_type = 'session_state'
  }

  /**
   * Load the session data from the barer token
   * @param {string} token The request object.
   */
  async load_data_from_bearer_token(token) {
    this._data = this.provider.bearer_token_session_cache_bank.get(token) || {}
    this._data = Object.assign(
      {},
      this.provider.bearer_token_session_cache_bank.get(token) || {},
      { access_token: token }
    )

    delete this.data.id_token

    this.session_type = 'bearer'
  }

  /**
   * Loads the OAuth provider session from the request.
   * @param {StratisOAuth2Provider} provider The provider
   * @param {Request} req The request object.
   * @param {string} bearer_token The bearer token to load from
   */
  static async load(provider, req, bearer_token = null) {
    bearer_token = bearer_token || parse_bearer_token(req)
    const oauth_session = new StratisOAuth2ProviderSession(provider, req)

    if (bearer_token != null)
      oauth_session.load_data_from_bearer_token(bearer_token)
    else oauth_session.load_data_from_session(req.session || {})
    return oauth_session
  }

  /**
   * Save the current state if needed.
   */
  async save() {
    switch (this.session_type) {
      case 'bearer':
        if (this.access_token == null) return false
        this.provider.bearer_token_session_cache_bank.set(
          this.access_token,
          this.data
        )
        return true
      case 'session_state':
        if (this.req.session == null) {
          this.provider.logger.warn(
            'Could not save oauth2 session state values. Request session object is null'
          )
          return false
        }

        this.req.session[this.provider.session_key] = this.data
        return true
      default:
        throw new Error(
          `Unknown session source ${this.session_type}, invalid session`
        )
    }
  }

  /**
   * Clear the current authentication.
   */
  async clear() {
    this._data = {}
    return await this.save()
  }
}

module.exports = {
  StratisOAuth2ProviderSession,
}
