const http = require('http')
const https = require('https')
const ProxyAgent = require('proxy-agent')
const { assert } = require('../common')

const { stream_to_buffer, create_content_stream } = require('./streams')

/**
 * @typedef {'string'|'json'|'bytes'|(buffer:Buffer)=>any} StreamDataParser
 * @typedef {import('./streams').StreamDataType} StreamDataType
 * @typedef {import('agent-base').AgentOptions} AgentOptions
 */

/**
 * @param {string} encoding The request encoding
 */
function get_stream_content_type(encoding) {
  // determine body type.
  /** @type {StreamDataType} */
  let data_type = 'bytes'
  switch (encoding) {
    case 'gzip':
      data_type = 'gzip'
      encoding = 'utf-8'
      break
    case 'deflate':
      data_type = 'deflate'
      encoding = 'utf-8'
      break
  }
  return data_type
}

/**
 * @typedef {Object} StratisRequestResponseExtensions
 * @property {()=>Buffer} to_buffer
 * @property {(message: string | (response: StratisRequestResponse)=>string, valid_status_codes:[])=>null} raise_status_errors
 * @property {(parse:StreamDataParser)=>Promise<any>} to_data
 * @property {(parse:StreamDataParser)=>Promise<Blob>} to_bytes
 * @property {(parse:StreamDataParser)=>Promise<string>} to_string
 * @property {(parse:StreamDataParser)=>Promise<any>} to_json
 *
 * @typedef {StratisRequestResponseExtensions & http.IncomingMessage} StratisRequestResponse
 */

/**
 * @typedef {Object} StratisRequestOptionsExtension
 * @property {Object|string|Buffer|ReadableStream} payload The request payload to send to the remote.
 * @property {boolean} use_pretty_json If true, and the payload is converted to json, use pretty format.
 * @property {string} custom_error_message If not null, added at the beginning of the error message.
 * @property {boolean} follow_redirects If true, then follow redirect requests.
 *
 * @typedef {http.RequestOptions & https.RequestOptions & StratisRequestOptionsExtension} StratisRequestOptions
 */

/**
 * @typedef {Object} StratisRequestsClientOptions
 * @property {boolean} use_proxies If true, check for proxies and use them (proxy-agent package)
 * @property {number} timeout The timeout for requests.
 * @property {boolean} follow_redirects If true, follow http redirects.
 */

class StratisRequestsClient {
  /**
   * @param {StratisRequestsClientOptions} param0
   */
  constructor({
    use_proxies = true,
    timeout = 1000 * 10,
    follow_redirects = true,
  } = {}) {
    this.use_proxies = use_proxies
    this.timeout = timeout || 1000 * 10 // default 5 mins.
    this.follow_redirects = follow_redirects
  }

  /**
   * @param {StratisRequestResponse} response The server response.
   * @param {string | (response: StratisRequestResponse)=>string} message The message to show. Can be null
   * @param {[number]} valid_status_codes
   */
  async raise_status_errors(
    response,
    message = null,
    valid_status_codes = null
  ) {
    if (valid_status_codes && valid_status_codes.includes(response.statusCode))
      return

    // valid http(s) response
    if (response.statusCode < 400) return

    if (message != null) {
      if (typeof message == 'object') message = JSON.stringify(message)
      else if (typeof message == 'function') message = message(response)
    }

    const msg_compose = [
      `Http/s invalid response (${response.statusCode}): ${response.statusMessage}`,
      message,
      (await stream_to_buffer(response)).toString(
        response.headers['content-encoding']
      ),
    ]
      .filter((v) => v != null)
      .map((v) => `${v}`)

    throw new Error(msg_compose.join('\n'))
  }

  /**
   * @param {StratisRequestResponse} response The server response.
   */
  async to_buffer(response) {
    await response.raise_status_errors()
    return await stream_to_buffer(response)
  }

  /**
   * @param {StratisRequestResponse} response The server response.
   * @param {StreamDataParser} parse
   */
  async to_data(response, parse = 'json') {
    // const data_type=
    const buffer = await this.to_buffer(response)
    const stream_encoding = response.headers['content-encoding'] || 'utf-8'
    const data_type = get_stream_content_type(stream_encoding)
    const data_encoding = data_type == 'bytes' ? stream_encoding : 'utf-8'

    if (typeof parse == 'function') return await parse(buffer)

    switch (parse) {
      case 'bytes':
        return new Blob(Uint8Array.from(buffer))
      case 'string':
        return buffer.toString(data_encoding)
      case 'json':
        const as_json = buffer.toString(data_encoding)
        return JSON.parse(as_json)
      default:
        throw new Error('Unknown parse type: ' + parse)
    }
  }
  /**
   * @param {StratisRequestResponse} response The server response.
   */
  async to_json(response) {
    return await this.to_data(response, 'json')
  }

  /**
   * @param {StratisRequestResponse} response The server response.
   */
  async to_string(response) {
    return await this.to_data(response, 'string')
  }

  /**
   * @param {StratisRequestResponse} response The server response.
   */
  async to_bytes(response) {
    return await this.to_data(response, 'bytes')
  }

  /**
   * @param {http.IncomingMessage} response The server response.
   * @returns {StratisRequestResponse} The stratis server response.
   */
  to_stratis_response_object(response) {
    response.to_buffer = (...args) => {
      return this.to_buffer(response, ...args)
    }
    response.to_data = (...args) => {
      return this.to_data(response, ...args)
    }
    response.to_bytes = (...args) => {
      return this.to_bytes(response, ...args)
    }
    response.to_string = (...args) => {
      return this.to_string(response, ...args)
    }
    response.to_json = (...args) => {
      return this.to_json(response, ...args)
    }
    response.raise_status_errors = (...args) => {
      return this.raise_status_errors(response, ...args)
    }
    return response
  }

  /**
   * Send an http/https request.
   * @param {URL|string} url The target url.
   * @param {StratisRequestOptions} options
   * @returns {Promise<StratisRequestResponse>}
   */
  async request(url, options = {}) {
    if (!(url instanceof URL)) {
      assert(typeof url == 'string', 'url must be of types string/URL')
      url = new URL(url)
    }

    assert(
      url.protocol == 'http:' || url.protocol == 'https:',
      'this request handler can only send http/https requests'
    )

    const handler = url.protocol == 'http:' ? http : https
    const original_options = options
    options = Object.assign({}, options)

    /** @type {http.OutgoingHttpHeaders} */
    const base_headers = {}

    if (this.use_proxies) {
    }

    if (options.payload != null) {
      if (typeof options.payload == 'string') {
        base_headers['Content-Type'] = 'application/text'
      } else if (options.payload instanceof Buffer) {
        base_headers['Content-Type'] = 'application/octet-stream'
      } else if (typeof options.payload == 'object') {
        options.payload =
          options.use_pretty_json === true
            ? JSON.stringify(options.payload, null, 2)
            : JSON.stringify(options.payload)
        base_headers['Content-Type'] = 'application/json'
      }
      base_headers['Content-Length'] = options.payload.length
    }

    const proxy_agent = this.use_proxies ? new ProxyAgent() : null
    if (this.use_proxies && this.timeout != null)
      proxy_agent.timeout = this.timeout

    /** @type {http.RequestOptions} */
    options = Object.assign(
      {
        agent: proxy_agent,
        method: 'GET',
        hostname: url.hostname,
        port: url.port || (url.protocol == 'http:' ? 80 : 443),
        path: `${url.pathname}${url.search}`,
        protocol: url.protocol,
        timeout: this.timeout,
        follow_redirects: this.follow_redirects,
      },
      options,
      {
        headers: Object.assign({}, base_headers, options.headers || {}),
      }
    )

    try {
      const res = this.to_stratis_response_object(
        await new Promise((resolve, reject) => {
          try {
            const req = handler.request(options, function (res) {
              resolve(res)
            })

            req.on('error', (err) => reject(err))

            if (req.writable && options.payload) {
              req.write(options.payload)
            }
            req.end()
          } catch (err) {
            reject(err)
          }
        })
      )

      if (
        options.follow_redirects === true &&
        typeof res.headers.location == 'string' &&
        [301, 302].includes(res.statusCode)
      ) {
        /** @type {[string]} */
        const redirection_already_visited =
          original_options.redirection_already_visited || []

        redirection_already_visited.push(url.href)

        if (redirection_already_visited.includes(res.headers.location))
          throw new Error(
            `Circular redirect detected:\n${redirection_already_visited.join(
              '\n -> '
            )}`
          )

        // redirecting to new location.
        return await this.request(
          res.headers.location,
          Object.assign({}, original_options, { redirection_already_visited })
        )
      }

      return res
    } catch (err) {
      if (options.custom_error_message) {
        err.message = `${options.custom_error_message} ${err.message}`
      }
      throw err
    }
  }

  /**
   * Send a GET http/https request.
   * The GET method requests a representation of the specified resource.
   * Requests using GET should only retrieve data.
   * @param {URL|string} url The target url.
   * @param {StratisRequestOptions} options
   */
  async get(url, options = {}) {
    return await this.request(url, options)
  }

  /**
   * Send a HEAD http/https request.
   * The HEAD method asks for a response identical to a GET request,
   * but without the response body.
   * @param {URL|string} url The target url.
   * @param {StratisRequestOptions} options
   */
  async head(url, options = {}) {
    options = Object.assign({}, options, {
      method: 'HEAD',
    })
    return await this.request(url, options)
  }

  /**
   * Send a POST http/https request as application/x-www-form-urlencoded content type.
   * This would use the body to hold the request. This command cannot have
   * a body payload.
   * @param {URL|string} url The target url.
   * @param {StratisRequestOptions} options
   */
  async post_form(url, options = {}) {
    options = Object.assign({}, options, {
      method: 'POST',
    })
    assert(options.payload == null, 'a post_form command cannot have a payload')

    // extracting the url parameters.
    if (!(url instanceof URL)) {
      assert(typeof url == 'string', 'url must be of types string/URL')
      url = new URL(url)
    }

    let url_parts = url.href.split('?')
    options.payload = url_parts[1]
    options.headers['Content-Type'] = 'application/x-www-form-urlencoded'

    return await this.request(url_parts[0], options)
  }

  /**
   * Send a POST http/https request.
   * The POST method submits an entity to the specified resource,
   * often causing a change in state or side effects on the server.
   * @param {URL|string} url The target url.
   * @param {Object|string|Buffer|ReadableStream} payload The request payload to send to the remote.
   * @param {StratisRequestOptions} options
   */
  async post(url, payload = null, options = {}) {
    options = Object.assign({}, options, {
      payload,
      method: 'POST',
    })
    return await this.request(url, options)
  }

  /**
   * Send a PUT http/https request.
   * The PUT method replaces all current representations of the target
   * resource with the request payload.
   * @param {URL|string} url The target url.
   * @param {Object|string|Buffer|ReadableStream} payload The request payload to send to the remote.
   * @param {StratisRequestOptions} options
   */
  async put(url, payload = null, options = {}) {
    options = Object.assign({}, options, {
      payload,
      method: 'PUT',
    })
    return await this.request(url, options)
  }

  /**
   * Send a PATCH http/https request.
   * The PATCH method applies partial modifications to a resource.
   * @param {URL|string} url The target url.
   * @param {Object|string|Buffer|ReadableStream} payload The request payload to send to the remote.
   * @param {StratisRequestOptions} options
   *
   */
  async patch(url, payload = null, options = {}) {
    options = Object.assign({}, options, {
      payload,
      method: 'PATCH',
    })
    return await this.request(url, options)
  }

  /**
   * Send a DELETE http/https request.
   * The DELETE method deletes the specified resource.
   * @param {URL|string} url The target url.
   * @param {StratisRequestOptions} options
   */
  async delete(url, options = {}) {
    options = Object.assign({}, options, {
      method: 'DELETE',
    })
    return await this.request(url, options)
  }

  /**
   * Send a CONNECT http/https request.
   * The CONNECT method establishes a tunnel to the server identified by the target resource.
   * @param {URL|string} url The target url.
   * @param {StratisRequestOptions} options
   *
   */
  async connect(url, options = {}) {
    options = Object.assign({}, options, {
      method: 'CONNECT',
    })

    return await this.request(url, options)
  }

  /**
   * Send a OPTIONS http/https request.
   * The OPTIONS method describes the communication options for the target resource.
   * @param {URL|string} url The target url.
   * @param {StratisRequestOptions} options
   *
   */
  async options(url, payload = null, options = {}) {
    options = Object.assign({}, options, {
      payload,
      method: 'OPTIONS',
    })
    return await this.request(url, options)
  }

  /**
   * Send a TRACE http/https request.
   * The TRACE method performs a message loop-back test along the path to the target resource.
   * @param {URL|string} url The target url.
   * @param {StratisRequestOptions} options
   */
  async trace(url, options = {}) {
    options = Object.assign({}, options, {
      method: 'TRACE',
    })
    return await this.request(url, options)
  }
}

/**
 * Send a http/https request.
 * @param {URL|string} url The target url.
 * @param {http.RequestOptions} options
 *
 */
async function request(url, options) {
  return await new StratisRequestsClient().request(url, options)
}

module.exports = {
  request,
  get_stream_content_type,
  StratisRequestsClient,
}
