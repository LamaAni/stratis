const express = require('express')
const { Stratis } = require('./webserver/stratis')
const { JsonCompatible, StratisApiObject } = require('./webserver/interfaces')
const { StratisPageCallContext } = require('./webserver/pages')
const { StratisCli } = require('./cli')
const websocket = require('./websocket')

/**
 * @typedef {import('./webserver/stratis').StratisOptions} StratisOptions
 * @typedef {import('./webserver/stratis').StratisEJSOptions} StratisEJSOptions
 * @typedef {import('./webserver/stratis').StratisMiddlewareOptions} StratisMiddlewareOptions
 * @typedef {import('./webserver/stratis').StratisClientSideApiOptions} StratisClientSideApiOptions
 * @typedef {import('./webserver/stratis').StratisCodeModuleBankOptions} StratisCodeModuleBankOptions
 * @typedef {import('./webserver/stratis').StratisEJSTemplateBankOptions} StratisEJSTemplateBankOptions
 */

module.exports = {
  websocket,
  JsonCompatible,
  StratisApiObject,
  Stratis,
  StratisCli,
  StratisPageCallContext,
}
