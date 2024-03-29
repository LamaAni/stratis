const stream = require('stream')
const path = require('path')
const {
  StratisNotFoundError,
  StratisNotAuthorizedError,
} = require('../errors.js')
const { assert } = require('../common')
const { stream_to_buffer } = require('../utils/streams.js')
const { Request, Response } = require('express')
const { StratisParseError } = require('../errors')
const WebSocket = require('ws')

/**
 * @typedef {import('./requests.js').StratisRequest} StratisRequest
 */

/**
 * @typedef {import('../utils/requests').StratisRequestsClient} StratisRequestsClient
 * @typedef {import('./interfaces').StratisApiHandler} StratisApiHandler
 * @typedef {import('./interfaces').StratisExpressRequest} StratisExpressRequest
 * @typedef {import('./interfaces').StratisExpressResponse} StratisExpressResponse
 * @typedef {import('./requests').StratisRequest} StratisRequest
 * @typedef {import('express/index').Response} Response
 * @typedef {import('express/index').NextFunction} NextFunction
 * @typedef {import('./stratis.js').Stratis} Stratis
 * @typedef {import('./interfaces').JsonCompatible} JsonCompatible
 */

/**
 * @typedef {Object} StratisPageCallContextOptions
 * @property {StratisRequest} stratis_request The stratis collected request
 * @property {StratisExpressResponse} res The express http response object
 * @property {NextFunction} next the express http next function.
 * @property {WebSocket} ws The WebSocket connection if applicable.
 */

/**
 * @typedef {Object} PageOptions
 * @property
 */

class StratisPageCallContext {
  /**
   * Implements the call context for stratis
   * @param {StratisPageCallContextOptions} param0
   */
  constructor({ stratis_request, res = null, next = null, ws = null } = {}) {
    assert(stratis_request != null, 'The stratis request must be defined')
    assert(
      ws instanceof WebSocket || res != null,
      'Response must defined Response or WebSocket must be defined'
    )

    this._stratis_request = stratis_request
    this._res = res
    this._ws = ws
    this._next = next

    /**
     * @type {{}} The code module dictionary for the request.
     */
    this._code_module = null
  }

  get res() {
    return this._res
  }

  get req() {
    return this.stratis_request.request
  }

  get ws() {
    return this._ws
  }

  get stratis_request() {
    return this._stratis_request
  }

  get is_websocket_request() {
    return this.ws != null
  }

  get websocket() {
    return this.ws
  }

  get stratis() {
    return this.stratis_request.stratis
  }

  get logger() {
    return this.stratis.logger
  }

  /** @type {Object<string,any>} */
  get cookies() {
    return this.req.cookies
  }

  get session() {
    return this.req.session
  }

  get next() {
    return this._next
  }

  /**
   * Requests client to send http/https requests
   * @type {StratisRequestsClient}
   */
  get requests() {
    return this.stratis.requests
  }

  /**
   * Check if the current security is permitted.
   * @param  {...any} args User parameters to check
   * @returns
   */
  async is_permitted(...args) {
    return await this.stratis_request.is_permitted(...args)
  }

  /**
   * Deny access to this resource
   * @param {boolean} message
   * @param {boolean} is_denied If true then the access is denied.
   */
  assert_permitted(condition, message = 'Permission denied') {
    if (!condition) throw new StratisNotAuthorizedError(message)
  }

  get_api_objects() {
    return Object.assign({}, this.stratis.template_options.common_api || {}, {
      render_stratis_api_yaml_description: (...args) =>
        this.render_stratis_api_description(...args),
      render_stratis_api_description: (...args) =>
        this.render_stratis_api_description(...args),
      render_stratis_browser_api_script: (...args) =>
        this.render_stratis_browser_api_script(...args),
    })
  }

  get_render_objects() {
    return Object.assign({}, this.get_api_objects(), {
      req: this.req,
      res: this.res,
      session: this.session,
      context: this,
    })
  }

  /**
   * @param {boolean} include_api_objects
   * @returns {Object<string, StratisApiHandler>}
   */
  async get_code_module_objects(include_api_objects = true) {
    const code_module_api_objects = (
      await this.stratis.code_module_bank.load(this.stratis_request.codepath)
    ).as_api_objects()

    return Object.assign(
      {},
      include_api_objects ? this.get_api_objects() : {},
      code_module_api_objects
    )
  }

  /**
   * Render stratis api script.
   * @param {Object} param0
   * @param {string} param0.api_name The name of the api
   * @param {string} param0.websocket_path The websocket path to use for inner pages
   */
  async render_stratis_browser_api_script({
    api_name = 'stratis',
    websocket_path = null,
    needs_core = true,
  }) {
    /** @type {StratisRequestEnvironment} */
    return await this.stratis_request.stratis.template_bank.render(
      this.stratis.client_api_options.api_code_path,
      {
        websocket_path,
        api_name,
        needs_core,
        code_module: await this.get_code_module_objects(),
        request: this.stratis_request,
        stratis: this.stratis,
        context: this,
      }
    )
  }

  async render_stratis_api_description() {
    const code_module = await this.get_code_module_objects(false)
    const api_description = {
      path: this.stratis_request.query_path,
      methods: Object.keys(code_module),
    }

    return JSON.stringify(api_description, null, 2)
  }
}

class StratisPageCall {
  /**
   * Implements a general page call.
   * @param {StratisRequest} request
   */
  constructor(request) {
    this.request = request
  }

  get stratis() {
    return this.request.stratis
  }

  get_search_params_dictionary() {
    const prs = {}
    for (var pair of this.request.url.searchParams.entries()) {
      if (pair.length < 2) continue
      prs[pair[0]] = pair[1]
    }
  }
}

class StratisPageApiCall extends StratisPageCall {
  /**
   * Implements behavior for an api call.
   * @param {StratisRequest} request
   * @param {string} name The name of the method to call.
   * @param {object} args The method args to include.
   * @param {boolean} include_query_args If true, query args are included in the call args.
   */
  constructor(request, name, args = null, include_query_args = false) {
    super(request)
    this._name = name
    this._args = null

    if (include_query_args) this.merge_args(this.get_search_params_dictionary())
    this.merge_args(args)
  }

  get name() {
    return this._name
  }

  get args() {
    return this._args
  }

  /**
   * Reads the api call args from the payload data. Multiple calls will
   * result in multiple reads.
   * @param {stream.Readable|Buffer|string|Object<string,any>} as_json The call payload data.
   * @param {ejs.Data} query_args The request query args if any.
   * @param {string} encoding The json string encoding
   * @returns {Object}
   */
  static async parse_api_call_args(
    as_json = null,
    query_args = null,
    encoding = 'utf-8'
  ) {
    encoding = encoding || 'utf-8'

    if (as_json == null) as_json = {}
    else {
      const is_stream = as_json instanceof stream.Readable
      const is_buffer = as_json instanceof Buffer

      if (is_stream || is_buffer) {
        if (is_stream) {
          as_json = await stream_to_buffer(as_json)
        }
        as_json = as_json.toString(encoding).trim()
        as_json = as_json.length == 0 ? null : as_json
      }

      if (as_json != null || typeof as_json == 'string') {
        if (as_json != null && /^\s*[\{]/gms.test(as_json))
          try {
            as_json = JSON.parse(as_json)
          } catch (err) {
            throw new StratisParseError(
              as_json,
              `Failed to parse stratis request payload: ${err}`
            )
          }
        else
          as_json = {
            payload: as_json,
          }
      }

      assert(
        typeof as_json == 'string' || typeof as_json == 'object',
        'Payload data must be either a buffer, stream, string or dictionary (or null)'
      )
    }

    if (query_args != null) return Object.assign({}, query_args, as_json)
    else return as_json
  }

  /**
   * Merge a dictionary to the call args.
   * @param {Object<string,any>} to_merge The args to merge.
   */
  merge_args(to_merge) {
    this._args = Object.assign(this._args || {}, to_merge)
  }

  /**
   * Invokes the api call.
   * @param {StratisPageCallContext} context
   * @returns {JsonCompatible} The json compatible return value.
   */
  async invoke(context) {
    // load the code module for the api
    const code_module = Object.assign(
      context.get_api_objects(),
      await context.get_code_module_objects()
    )

    if (code_module[this.name] == null) {
      throw new StratisNotFoundError('Api method or object not found')
    }

    const to_invoke = code_module[this.name]
    if (typeof to_invoke != 'function') return to_invoke
    else return await to_invoke(this.args, context)
  }
}

class StratisPageRenderRequest extends StratisPageCall {
  /**
   * Implements behavior for a page render request
   * @param {StratisRequest} request
   */
  constructor(request) {
    super(request)
  }

  /**
   * Render a stratis request.
   * @param {StratisPageCallContext} context The request
   * @returns {JsonCompatible} response
   */
  async render(context) {
    return await this.request.stratis.template_bank.render(
      this.request.filepath,
      context.get_render_objects()
    )
  }
}

module.exports = {
  StratisPageCall,
  StratisPageCallContext,
  StratisPageApiCall,
  StratisPageRenderRequest,
}
