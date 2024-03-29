const express = require('express')
const events = require('events')
const path = require('path')
const { Readable } = require('stream')
const fs = require('fs')
const { Request, Response, NextFunction } = require('express/index')
const websocket = require('../utils/websocket.js')
const { assert, with_timeout } = require('../common.js')
const { create_content_stream, stream_to_buffer } = require('../utils/streams')
const { get_stream_content_type } = require('../utils/requests')
const { StratisRequestsClient } = require('../utils/requests')

const {
  StratisNotFoundError,
  StratisError,
  StratisTimeOutError,
  StratisNotAuthorizedError,
} = require('../errors')
const { StratisRequest } = require('./requests.js')
const { StratisCodeModuleBank } = require('./code.js')
const { StratisEJSTemplateBank } = require('./templates')

const {
  StratisPageApiCall,
  StratisPageRenderRequest,
  StratisPageCallContext,
} = require('./pages.js')

const {
  DEFAULT_PAGE_OPTIONS,
  DEFAULT_LOGGING_OPTIONS,
  DEFAULT_SESSION_OPTIONS,
  DEFAULT_MIDDLEWARE_OPTIONS,
  DEFAULT_CLIENT_API_OPTIONS,
  DEFAULT_TEMPLATE_OPTIONS,
  DEFAULT_TEMPLATE_BANK_OPTIONS,
  DEFAULT_CODE_MODULE_BANK_OPTIONS,
} = require('./consts.js')

/**
 * @typedef {import('./interfaces').StratisEventListenRegister} StratisEventListenRegister
 * @typedef {import('./interfaces').Request} Request
 * @typedef {import('./interfaces').Response} Response
 * @typedef {import('./interfaces').StratisLogger} StratisLogger
 * @typedef {import('./interfaces').StratisExpressRequest} StratisExpressRequest
 * @typedef {import('./interfaces').StratisExpressResponse} StratisExpressResponse
 * @typedef {import('./interfaces').StratisEventEmitter} StratisEventEmitter
 * @typedef {import('./interfaces').StratisApiHandler} StratisApiHandler
 * @typedef {import('./interfaces').StratisApiWebSocketRequestArgs} StratisApiWebSocketRequestArgs
 * @typedef {import('./pages').StratisPageCallContext} StratisPageCallContext
 * @typedef {import('./requests').StratisFileAccessMode} StratisFileAccessMode
 * @typedef {import('./templates').StratisEJSOptions} StratisEJSOptions
 * @typedef {import('./templates').StratisEJSTemplateBankOptions} StratisEJSTemplateBankOptions
 * @typedef {import('./code').StratisCodeModule} StratisCodeModule
 * @typedef {import('./code').StratisCodeModuleBankOptions} StratisCodeModuleBankOptions
 */

/**
 * @typedef {Object} StratisClientSideApiOptions
 * @property {string} api_code_path The path to the api code to use (render)
 * @property {number} timeout The client side api timeout. Defaults to server side timeout.
 */

/**
 * @typedef {Object} StratisMiddlewareOptions
 * @property {string} serve_path The path to serve.
 * @property {(req:StratisExpressRequest,res:StratisExpressResponse,next:NextFunction)=>{}} filter Path filter, if next
 * function is called then skips the middleware.
 * @property {(req:StratisExpressRequest,res:StratisExpressResponse,next:NextFunction, authenticate:boolean)=>{}} authenticate Secure resources validation filter.
 * return false or throw error when not accesable. Defaults to allow all.
 * @property {boolean} next_on_private Call the next express handler if the current
 * filepath request is private.
 * @property {boolean} next_on_not_found Call the next express handler if the current
 * filepath request is not found.
 * @property {boolean} ignore_empty_path If true, next handler on empty path.
 * @property {string} user_key The request object key for retrieving user info.
 */

/**
 * @typedef {Object} StratisSessionOptions
 * @property {(req:StratisExpressRequest,...permit_args)=>boolean} is_permitted A method to check if the
 * current request is allowed.
 */

/**
 * @typedef {Object} StratisTemplateOptionsExtension
 * @property {string} codefile_extension The file extension (without starting .) for recognizing code files.
 * @property {Object<string,StratisApiHandler>} common_api A collection of core api objects or
 * methods to expose.
 *
 * @typedef {StratisTemplateOptionsExtension & StratisEJSOptions} StratisTemplateOptions
 */

/**
 * @typedef {Object} StratisLoggingOptions
 * @property {StratisLogger} logger The logger to use,
 * must have logging methods (info, warn, error ...)
 * @property {boolean} log_errors If true, prints the application errors to the logger.
 * @property {boolean} next_on_error If true, errors on express request are sent to the next handler.
 * @property {boolean} return_stack_trace_to_client If true, prints the application errors to the http 500 response.
 * NOTE! To be used for debug, may expose sensitive information.
 */

/**
 * @typedef {Object} StratisPageOptions
 * @property {StratisPageCallContext} page_context_constructor A page call context constructor
 * @property {integer} timeout The client side request timeout [ms]
 * @property {[string]} page_extensions A list of extensions that denote a template page. For example .html
 */

/**
 * Interface for Stratis options.
 * @typedef {Object} StratisOptions
 * @property {StratisSessionOptions} session_options A collection of security options for stratis.
 * @property {StratisPageOptions} page_options A collection of options for pages.
 * @property {StratisLoggingOptions} logging_options A collection of options for logging.
 * @property {StratisTemplateOptions} template_options A collection of stratis extended ejs and template options.
 * @property {StratisEJSTemplateBankOptions} template_bank_options A collection of template bank options.
 * @property {StratisCodeModuleBankOptions} code_module_bank_options A collection of options for the code module bank
 * @property {StratisMiddlewareOptions} middleware_options A collection of default middleware options.
 * @property {StratisClientSideApiOptions} client_api_options client api options.
 */

const STRATIS_CLIENTSIDE_API_DEFAULT_OPTIONS = {
  api_code_path: path.join(__dirname, 'clientside.js'),
}

/**
 * @type {StratisEJSOptions}
 */
const STRATIS_DEFAULT_EJS_OPTIONS = {
  add_require: true,
}

function merge_missing(target, to_merge) {
  target = target || {}
  assert(
    typeof target == 'object',
    'An option collection must be of type Object'
  )
  for (let key of Object.keys(to_merge))
    if (!(key in target)) target[key] = to_merge[key]
  return target
}

class Stratis extends events.EventEmitter {
  /**
   * Creates a file api handler that can be used to generate
   * the file api.
   * @param {StratisOptions} param0
   */
  constructor({
    session_options = null,
    page_options = null,
    logging_options = null,
    middleware_options = null,
    client_api_options = null,
    template_options = null,
    template_bank_options = null,
    code_module_bank_options = null,
  } = {}) {
    super()

    /** @type {StratisSessionOptions} */
    this.session_options = merge_missing(
      session_options,
      DEFAULT_SESSION_OPTIONS
    )

    /** @type {StratisPageOptions} */
    this.page_options = merge_missing(page_options, DEFAULT_PAGE_OPTIONS)

    /** @type {StratisLoggingOptions} */
    this.logging_options = merge_missing(
      logging_options,
      DEFAULT_LOGGING_OPTIONS
    )

    /** @type {StratisMiddlewareOptions} */
    this.middleware_options = merge_missing(
      middleware_options,
      DEFAULT_MIDDLEWARE_OPTIONS
    )

    /** @type {StratisClientSideApiOptions} */
    this.client_api_options = merge_missing(
      client_api_options,
      DEFAULT_CLIENT_API_OPTIONS
    )

    /** @type {StratisTemplateOptions} */
    this.template_options = merge_missing(
      template_options,
      DEFAULT_TEMPLATE_OPTIONS
    )

    /** @type {StratisEJSTemplateBankOptions} */
    template_bank_options = merge_missing(
      template_bank_options,
      DEFAULT_TEMPLATE_BANK_OPTIONS
    )

    /** @type {StratisCodeModuleBankOptions} */
    code_module_bank_options = merge_missing(
      code_module_bank_options,
      DEFAULT_CODE_MODULE_BANK_OPTIONS
    )

    this.page_options.page_context_constructor =
      this.page_options.page_context_constructor || StratisPageCallContext

    // validating default options
    assert(
      this.page_options.page_context_constructor.prototype.constructor ==
        StratisPageCallContext ||
        this.page_options.page_context_constructor instanceof
          StratisPageCallContext,
      'this.page_options.page_context_constructor must be of type StratisPageCallContext'
    )

    /** @type {StratisEventListenRegister} */
    this.on
    /** @type {StratisEventListenRegister} */
    this.once
    /** @type {StratisEventEmitter} */
    this.emit

    this.on('error', (...args) => this._internal_on_emit_error(...args))

    // collections
    this.template_bank = new StratisEJSTemplateBank(this, template_bank_options)
    this.code_module_bank = new StratisCodeModuleBank(
      this,
      code_module_bank_options
    )

    /** @type {StratisRequestsClient} */
    this._requests = new StratisRequestsClient()
  }

  /**
   * Requests client to send http/https requests
   * @type {StratisRequestsClient}
   */
  get requests() {
    return this._requests
  }

  get logger() {
    return this.logging_options.logger
  }

  /** @type {StratisEventEmitter} */
  async emit_async(event, ...args) {
    assert(
      typeof event == 'string' || typeof event == 'symbol',
      'Event type must be a string or a symbol'
    )
    if (typeof event !== 'string' && typeof event !== 'symbol') {
      throw new TypeError('type is not type of string or symbol!')
    }

    const listeners = this.listeners(event)
    if (listeners.length == 0) return false
    for (let listener of listeners) {
      await listener.apply(this, args)
    }

    return true
  }

  /**
   * Emits a stratis error.
   * @param {Error} err The error
   * @param {StratisExpressRequest} req The request
   * @param {[integer]} codes The http codes for which to emit an error.
   * If null then all.
   */
  emit_error(err, req = null, codes = [500]) {
    const http_response_code = err.http_response_code || 500

    if (codes == null || codes.includes(http_response_code))
      // application error.
      this.emit('error', err, req)
  }

  /**
   * Emits the startis request event.
   * @param {StratisRequest} stratis_request The request
   */
  async emit_stratis_request(stratis_request) {
    await this.emit_async('stratis_request', stratis_request)
  }

  /**
   * Compose codefile path for the code file.
   * @param {string} file_path The file path to compose a codefile for.
   */
  compose_codefile_path(file_path) {
    return (
      file_path.replace(/\.[^/.]+$/, '') +
      this.template_options.codefile_extension
    )
  }

  /**
   * @param {string} file_path The filepath to check
   */
  is_codefile(file_path) {
    return file_path.endsWith(this.template_options.codefile_extension)
  }

  /**
   * @param {Error} err
   * @param {StratisExpressRequest} stratis_request
   */
  _internal_on_emit_error(err, req) {
    const request_log_errors =
      req.stratis_request != null && req.stratis_request.log_errors === true

    if (request_log_errors || this.logging_options.log_errors)
      this.logger.error(err.stack || `${err}`)
  }

  /**
   * @param {StratisRequest} stratis_request
   * @param {StratisExpressResponse} res
   * @param {NextFunction} next
   */
  async handle_websocket_request(stratis_request, res, next) {
    websocket((ws, ws_request) => {
      ws.on('message', async (data) => {
        /** @type {StratisApiWebSocketRequestArgs} */
        let ws_request_args = {}
        try {
          ws_request_args = await StratisPageApiCall.parse_api_call_args(
            data,
            {},
            stratis_request.request.headers['content-encoding']
          )
          ws_request_args.args = ws_request_args.args || {}
          if (
            ws_request_args.rid == null ||
            ws_request_args.name == null ||
            typeof ws_request_args.args != 'object'
          )
            throw Error(
              'Invalid stratis api websocket request. Expected {rid:string, name:string, args:{} }'
            )

          const call = new StratisPageApiCall(
            stratis_request,
            ws_request_args.name,
            ws_request_args.args
          )

          const context = new this.page_options.page_context_constructor({
            stratis_request,
            ws,
          })

          stratis_request._context = context

          // invoking the event.
          await this.emit_stratis_request(stratis_request)

          let rsp_data = await with_timeout(
            async () => {
              return await call.invoke(context)
            },
            this.page_options.timeout,
            new StratisTimeOutError('Websocket request timed out')
          )

          if (rsp_data instanceof Readable)
            rsp_data = await stream_to_buffer(rsp_data)

          ws.send(
            JSON.stringify({
              rid: ws_request_args.rid,
              response: rsp_data,
            })
          )
        } catch (err) {
          this.emit_error(err, stratis_request.request)
          try {
            ws.send(
              JSON.stringify({
                rid: ws_request_args.rid,
                reload: err.requires_reload === true,
                error: this._render_error_text(
                  err,
                  stratis_request.return_stack_trace_to_client
                ),
              })
            )
          } catch (err) {
            this.emit_error(err, stratis_request.request)
          }
        }
      })

      ws.on('open', () => this.emit('websocket_open', ws))
      ws.on('close', () => this.emit('websocket_close', ws))
      ws.on('error', (err) => this.emit_error(err, stratis_request.request))
    })(stratis_request.request, res, next)
  }

  /**
   * @param {StratisRequest} stratis_request
   * @param {StratisExpressResponse} res
   * @param {NextFunction} next
   */
  async handle_page_api_call(stratis_request, res, next) {
    // resolve api method path.
    const name = stratis_request.api_path
      .split('/')
      .filter((v) => v.trim().length > 0)
      .join('.')

    // checking request payload type.
    const encoding =
      stratis_request.request.headers['content-encoding'] || 'utf-8'
    const content_type = stratis_request.request.headers['content-type']

    let payload = null
    if (
      (content_type == null || /\bjson\b/.test(content_type.toLowerCase())) &&
      stratis_request.request.readable
    )
      payload = stratis_request.request.body || stratis_request.request

    const call = new StratisPageApiCall(
      stratis_request,
      name,
      await StratisPageApiCall.parse_api_call_args(
        payload,
        stratis_request.request.query,
        encoding
      ),
      true
    )

    const context = new this.page_options.page_context_constructor({
      stratis_request,
      res,
      next,
    })

    stratis_request._context = context

    let rslt = await call.invoke(context)

    if (res.writableEnded) return

    if (rslt instanceof Readable) {
      /** @type {Readable} */
      const readable_rslt = rslt
      if (readable_rslt.readableEnded)
        throw new Error(
          'Cannot process readable invoke result that has ended. [Readable].readableEnded = true'
        )

      readable_rslt.pipe(res)

      return await new Promise((resolve, reject) => {
        readable_rslt.on('end', () => {
          res.end()
          resolve()
        })
        readable_rslt.on('error', (err) => {
          reject(err)
        })
      })
    }

    // all but buffer should be converted.
    if (rslt instanceof Buffer) {
    } else if (typeof rslt == 'object') rslt = JSON.stringify(rslt)

    return res.end(rslt)
  }

  /**
   * @param {StratisRequest} stratis_request
   * @param {StratisExpressResponse} res
   * @param {NextFunction} next
   */
  async handle_page_render_request(stratis_request, res, next) {
    const call = new StratisPageRenderRequest(stratis_request)
    const context = new this.page_options.page_context_constructor({
      stratis_request,
      res,
      next,
    })

    stratis_request._context = context

    const rslt = await call.render(context)
    if (res.writableEnded) return
    return res.end(rslt)
  }

  /**
   * @param {StratisRequest} stratis_request
   * @param {Response} res
   * @param {NextFunction} next
   */
  async handle_page_request(stratis_request, res, next) {
    // a page request can be either:
    // page render request
    // page api request.

    // invoking the event.
    await this.emit_stratis_request(stratis_request)

    if (stratis_request.api_path != null)
      return await this.handle_page_api_call(stratis_request, res, next)
    else
      return await this.handle_page_render_request(stratis_request, res, next)
  }

  /**
   * INTERNAL.
   * @param {Error} err The error.
   * @param {boolean} return_stack_trace
   */
  _render_error_text(err, return_stack_trace = null) {
    return_stack_trace =
      return_stack_trace === null
        ? this.logging_options.return_stack_trace_to_client
        : return_stack_trace

    return return_stack_trace ? `${err.stack || err}` : `${err.message || err}`
  }

  /**
   * Handle errors with stratis.
   * @param {Error} err The error
   * @param {StratisExpressRequest} req The express request
   * @param {StratisExpressResponse} res The express response
   * @param {NextFunction} next The express next function
   */
  async handle_errors(err, req, res, next) {
    /** @type {StratisRequest} */
    const stratis_request = req.stratis_request || {}
    if (err instanceof StratisError) await err.handle_error(req, res, next)

    // Check the emit error event. Will be false if defined.
    if (err.emit_error !== false) this.emit_error(err, req)

    res.status(err.http_response_code || 500)

    res.end(
      this._render_error_text(err, stratis_request.return_stack_trace_to_client)
    )
  }

  /**
   * @param {StratisRequest} stratis_request
   * @param {Request} req
   * @param {Response} res
   * @returns {{req:StratisExpressRequest, res: StratisExpressResponse}}
   */
  async _bind_stratis_request_elements(stratis_request, req, res) {
    req.stratis = this
    res.stratis = this
    req.stratis_request = stratis_request
    res.stratis_request = stratis_request

    if (req.body == null) {
      // determine body type.
      const data_type = get_stream_content_type(
        req.headers['content-encoding'] || 'utf-8'
      )
      req.body = create_content_stream(req, data_type)
    }

    return { req, res }
  }

  /**
   * @param {StratisExpressRequest} req
   * @param {StratisExpressResponse} res
   */
  _clean_stratis_request_elements(req, res) {
    delete req.stratis
    delete res.stratis
    delete req.stratis_request
    delete res.stratis_request
  }

  /**
   * Creates an express middleware that serves requests.
   * @param {StratisMiddlewareOptions} options
   */
  middleware(options = {}) {
    return this._middleware(
      Object.assign({}, this.middleware_options || {}, options || {})
    )
  }

  /**
   * @param {StratisMiddlewareOptions} options
   */
  _middleware({
    serve_path,
    filter = null,
    authenticate = null,
    next_on_private = false,
    next_on_not_found = true,
    ignore_empty_path = true,
    user_key = 'user',
  }) {
    assert(serve_path != null, 'Serve path must be defined!')

    if (!fs.existsSync(serve_path))
      throw new StratisNotFoundError(
        `Stratis search path ${serve_path} dose not exist`
      )

    const src_stat = fs.statSync(serve_path)

    assert(
      src_stat.isDirectory(),
      Error(`Stratis search path ${serve_path} must point to a directory`)
    )

    /** @type {StratisFileAccessMode} */
    const default_access_mode =
      this.default_access_mode ||
      (fs.existsSync(path.join(serve_path, 'public')) ? 'private' : 'public')

    /**
     * Interception function for the middleware.
     * @param {Request} req
     * @param {Response} res
     * @param {NextFunction} next
     */
    const intercept = async (req, res, next) => {
      if (ignore_empty_path && req.path == '/') return next()

      const stratis_request = new StratisRequest({
        serve_path,
        stratis: this,
        request: req,
        access_mode: default_access_mode,
        return_stack_trace_to_client:
          this.logging_options.return_stack_trace_to_client,
        log_errors: this.logging_options.log_errors,
        user_key,
      })

      var { req, res } = await this._bind_stratis_request_elements(
        stratis_request,
        req,
        res
      )

      // check filtering.
      try {
        if (filter != null) {
          let filter_called_next = false
          let filter_rslt = filter(req, res, (...args) => {
            filter_called_next = true
            return next(...args)
          })
          if (filter_called_next) return filter_rslt
        }

        await stratis_request.initialize()

        // filepath dose not exist. Move on to next handler.
        if (!stratis_request.filepath_exists)
          if (next_on_not_found) return next()
          else throw new StratisNotFoundError()

        // check permissions
        if (stratis_request.access_mode == 'private') {
          if (next_on_private) return next()
          if (stratis_request.is_codefile)
            res.write('Direct access to codefiles is always forbidden')
          return res.sendStatus(403)
        }

        if (authenticate != null) {
          // authentication runs internally so next would mean continue
          let sf_next_error = null
          const sf_next = (...args) => {
            if (args[0] instanceof Error) sf_next_error = args[0]
          }

          await authenticate(
            req,
            res,
            sf_next,
            stratis_request.access_mode == 'secure'
          )

          // checking for errors.
          if (sf_next_error != null) {
            throw sf_next_error
          }

          // response has ended. Either redirect or response.
          // no need to continue.
          if (res.writableEnded) return

          if (stratis_request.access_mode == 'secure') {
            if (!(await stratis_request.is_permitted()))
              throw new StratisNotAuthorizedError(
                `Cannot access secure resources. Permission for ${stratis_request.query_path} denied.`
              )
          }
        }

        if (!stratis_request.is_page)
          // file download.
          return res.sendFile(stratis_request.filepath)

        return await with_timeout(
          async () => {
            if (stratis_request.is_websocket_request)
              // open websocket
              return this.handle_websocket_request(stratis_request, res, next)
            return this.handle_page_request(stratis_request, res, next)
          },
          this.page_options.timeout,
          new StratisTimeOutError('timed out processing request')
        )
      } catch (err) {
        await this.handle_errors(err, req, res, next)
      } finally {
        this._clean_stratis_request_elements(req, res)
      }
    }

    return intercept
  }

  /**
   * Creates a new express server to use with the Stratis.
   * @param {StratisMiddlewareOptions} options The middleware options.
   * @param {express.Express} app The express app to use, Will auto create or default to cli app.
   * @returns {express.Express} The express app to use. Will auto create or default to cli app.
   */
  server(options = {}, app = null) {
    // This method must be async since some derived classes override it.
    app = app || express()
    app.use(this.middleware(options))
    return app
  }
}

module.exports = {
  Stratis,
}
