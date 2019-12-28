'use strict'

const multipart = require('ipfs-multipart')
const debug = require('debug')
const tar = require('tar-stream')
const log = debug('ipfs:http-api:files')
log.error = debug('ipfs:http-api:files:error')
const toIterable = require('stream-to-it')
const Joi = require('@hapi/joi')
const Boom = require('@hapi/boom')
const { PassThrough } = require('readable-stream')
const multibase = require('multibase')
const isIpfs = require('is-ipfs')
const promisify = require('promisify-es6')
const { cidToString } = require('../../../utils/cid')
const { Format } = require('../../../core/components/refs')
const pipe = require('it-pipe')
const all = require('it-all')
const concat = require('it-concat')
const ndjson = require('iterable-ndjson')

function numberFromQuery (query, key) {
  if (query && query[key] !== undefined) {
    const value = parseInt(query[key], 10)

    if (isNaN(value)) {
      return undefined
    }

    return value
  }
}

// common pre request handler that parses the args and returns `key` which is assigned to `request.pre.args`
exports.parseKey = (request, h) => {
  const { arg } = request.query

  if (!arg) {
    throw Boom.badRequest("Argument 'key' is required")
  }

  const isArray = Array.isArray(arg)
  const args = isArray ? arg : [arg]
  for (const arg of args) {
    if (!isIpfs.ipfsPath(arg) && !isIpfs.cid(arg) && !isIpfs.ipfsPath('/ipfs/' + arg)) {
      throw Boom.badRequest(`invalid ipfs ref path '${arg}'`)
    }
  }

  return {
    key: isArray ? args : arg,
    options: {
      offset: numberFromQuery(request.query, 'offset'),
      length: numberFromQuery(request.query, 'length')
    }
  }
}

exports.cat = {
  // uses common parseKey method that returns a `key`
  parseArgs: exports.parseKey,

  // main route handler which is called after the above `parseArgs`, but only if the args were valid
  async handler (request, h) {
    const { ipfs } = request.server.app
    const { key, options } = request.pre.args

    // eslint-disable-next-line no-async-promise-executor
    const stream = await new Promise(async (resolve, reject) => {
      let started = false
      const stream = new PassThrough()

      try {
        await pipe(
          ipfs.cat(key, options),
          async function * (source) {
            for await (const chunk of source) {
              if (!started) {
                started = true
                resolve(stream)
              }
              yield chunk
            }
          },
          toIterable.sink(stream)
        )
      } catch (err) {
        log.error(err)

        err.message = err.message === 'file does not exist'
          ? err.message
          : 'Failed to cat file: ' + err

        reject(err)
      }
    })

    return h.response(stream).header('X-Stream-Output', '1')
  }
}

exports.get = {
  // uses common parseKey method that returns a `key`
  parseArgs: exports.parseKey,

  // main route handler which is called after the above `parseArgs`, but only if the args were valid
  async handler (request, h) {
    const { ipfs } = request.server.app
    const { key } = request.pre.args
    const pack = tar.pack()

    let filesArray
    try {
      filesArray = await all(ipfs.get(key))
    } catch (err) {
      throw Boom.boomify(err, { message: 'Failed to get key' })
    }

    pack.entry = promisify(pack.entry.bind(pack))

    Promise
      .all(filesArray.map(async file => {
        if (!file.content) {
          return pack.entry({ name: file.path, type: 'directory' })
        }
        const content = await concat(file.content)
        return pack.entry({ name: file.path, size: file.size }, content.slice())
      }))
      .then(() => pack.finalize())
      .catch(err => {
        log.error(err)
        pack.emit('error', err)
        pack.destroy()
      })

    // reply must be called right away so that tar-stream offloads its content
    // otherwise it will block in large files
    return h.response(pack).header('X-Stream-Output', '1')
  }
}

exports.add = {
  validate: {
    query: Joi.object()
      .keys({
        'cid-version': Joi.number().integer().min(0).max(1).default(0),
        'cid-base': Joi.string().valid(...multibase.names),
        'raw-leaves': Joi.boolean(),
        'only-hash': Joi.boolean(),
        pin: Joi.boolean().default(true),
        'wrap-with-directory': Joi.boolean(),
        'file-import-concurrency': Joi.number().integer().min(0).default(50),
        'block-write-concurrency': Joi.number().integer().min(0).default(10),
        chunker: Joi.string(),
        trickle: Joi.boolean(),
        preload: Joi.boolean().default(true)
      })
      // TODO: Necessary until validate "recursive", "stream-channels" etc.
      .options({ allowUnknown: true })
  },

  handler (request, h) {
    if (!request.payload) {
      throw Boom.badRequest('Array, Buffer, or String is required.')
    }

    const { ipfs } = request.server.app
    let filesParsed = false
    let currentFileName
    const output = new PassThrough()
    const progressHandler = bytes => {
      output.write(JSON.stringify({
        Name: currentFileName,
        Bytes: bytes
      }) + '\n')
    }

    pipe(
      multipart(request),
      async function * (source) {
        for await (const entry of source) {
          currentFileName = entry.name || 'unknown'

          if (entry.type === 'file') {
            filesParsed = true

            yield {
              path: entry.name,
              content: entry.content
            }
          }

          if (entry.type === 'directory') {
            filesParsed = true

            yield {
              path: entry.name
            }
          }
        }
      },
      function (source) {
        return ipfs.add(source, {
          cidVersion: request.query['cid-version'],
          rawLeaves: request.query['raw-leaves'],
          // FIXME: can pass null when merged: https://github.com/ipfs/js-ipfs-unixfs-importer/pull/43
          progress: request.query.progress ? progressHandler : () => {},
          onlyHash: request.query['only-hash'],
          hashAlg: request.query.hash,
          wrapWithDirectory: request.query['wrap-with-directory'],
          pin: request.query.pin,
          chunker: request.query.chunker,
          trickle: request.query.trickle,
          preload: request.query.preload,

          // this has to be hardcoded to 1 because we can only read one file
          // at a time from a http request and we have to consume it completely
          // before we can read the next file
          fileImportConcurrency: 1,
          blockWriteConcurrency: request.query['block-write-concurrency']
        })
      },
      async function (source) {
        for await (const file of source) {
          output.write(JSON.stringify({
            Name: file.path,
            Hash: cidToString(file.cid, { base: request.query['cid-base'] }),
            Size: file.size
          }) + '\n')
        }
      }
    )
      .then(() => {
        if (!filesParsed) {
          throw new Error("File argument 'data' is required.")
        }
      })
      .catch(err => {
        if (!filesParsed) {
          output.write(' ')
        }

        request.raw.res.addTrailers({
          'X-Stream-Error': JSON.stringify({
            Message: err.message,
            Code: 0
          })
        })
      })
      .then(() => {
        output.end()
      })

    return h.response(output)
      .header('x-chunked-output', '1')
      .header('content-type', 'application/json')
      .header('Trailer', 'X-Stream-Error')
  }
}

exports.ls = {
  validate: {
    query: Joi.object().keys({
      'cid-base': Joi.string().valid(...multibase.names)
    }).unknown()
  },

  // uses common parseKey method that returns a `key`
  parseArgs: exports.parseKey,

  // main route handler which is called after the above `parseArgs`, but only if the args were valid
  async handler (request, h) {
    const { ipfs } = request.server.app
    const { key } = request.pre.args
    const recursive = request.query && request.query.recursive === 'true'
    const cidBase = request.query['cid-base']

    // eslint-disable-next-line no-async-promise-executor
    const stream = await new Promise(async (resolve, reject) => {
      let started = false
      const stream = new PassThrough()

      try {
        await pipe(
          ipfs.ls(key, { recursive }),
          async function * (source) {
            for await (const file of source) {
              if (!started) {
                started = true
                resolve(stream)
              }
              yield {
                Name: file.name,
                Hash: cidToString(file.cid, { base: cidBase }),
                Size: file.size,
                Type: toTypeCode(file.type),
                Depth: file.depth
              }
            }
          },
          ndjson.stringify,
          toIterable.sink(stream)
        )
      } catch (err) {
        reject(err)
      }
    })

    return h.response(stream).header('X-Stream-Output', '1')
  }
}

function toTypeCode (type) {
  switch (type) {
    case 'dir':
      return 1
    case 'file':
      return 2
    default:
      return 0
  }
}

exports.refs = {
  validate: {
    query: Joi.object().keys({
      recursive: Joi.boolean().default(false),
      format: Joi.string().default(Format.default),
      edges: Joi.boolean().default(false),
      unique: Joi.boolean().default(false),
      'max-depth': Joi.number().integer().min(-1)
    }).unknown()
  },

  // uses common parseKey method that returns a `key`
  parseArgs: exports.parseKey,

  // main route handler which is called after the above `parseArgs`, but only if the args were valid
  handler (request, h) {
    const { ipfs } = request.server.app
    const { key } = request.pre.args

    const options = {
      recursive: request.query.recursive,
      format: request.query.format,
      edges: request.query.edges,
      unique: request.query.unique,
      maxDepth: request.query['max-depth']
    }

    // have to do this here otherwise the validation error appears in the stream tail and
    // this doesn't work in browsers: https://github.com/ipfs/js-ipfs/issues/2519
    if (options.edges && options.format !== Format.default) {
      throw Boom.badRequest('Cannot set edges to true and also specify format')
    }

    return streamResponse(request, h, async (output) => {
      for await (const ref of ipfs._refsAsyncIterator(key, options)) {
        output.write(
          JSON.stringify({
            Ref: ref.ref,
            Err: ref.err
          }) + '\n'
        )
      }
    })
  }
}

exports.refs.local = {
  // main route handler
  handler (request, h) {
    const { ipfs } = request.server.app

    return streamResponse(request, h, async (output) => {
      for await (const ref of ipfs.refs._localAsyncIterator()) {
        output.write(
          JSON.stringify({
            Ref: ref.ref,
            Err: ref.err
          }) + '\n'
        )
      }
    })
  }
}

function streamResponse (request, h, fn) {
  const output = new PassThrough()
  const errorTrailer = 'X-Stream-Error'

  Promise.resolve()
    .then(() => fn(output))
    .catch(err => {
      request.raw.res.addTrailers({
        [errorTrailer]: JSON.stringify({
          Message: err.message,
          Code: 0
        })
      })
    })
    .finally(() => {
      output.end()
    })

  return h.response(output)
    .header('x-chunked-output', '1')
    .header('content-type', 'application/json')
    .header('Trailer', errorTrailer)
}
