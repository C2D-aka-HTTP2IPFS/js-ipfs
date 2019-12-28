'use strict'

const multibase = require('multibase')
const { rightpad } = require('../utils')
const { cidToString } = require('../../utils/cid')

module.exports = {
  command: 'ls <key>',

  describe: 'List files for the given directory',

  builder: {
    v: {
      alias: 'headers',
      desc: 'Print table headers (Hash, Size, Name).',
      type: 'boolean',
      default: false
    },
    r: {
      alias: 'recursive',
      desc: 'List subdirectories recursively',
      type: 'boolean',
      default: false
    },
    'resolve-type': {
      desc: 'Resolve linked objects to find out their types. (not implemented yet)',
      type: 'boolean',
      default: false // should be true when implemented
    },
    'cid-base': {
      describe: 'Number base to display CIDs in.',
      type: 'string',
      choices: multibase.names
    }
  },

  handler ({ getIpfs, print, key, recursive, headers, cidBase, resolve }) {
    resolve((async () => {
      // replace multiple slashes
      key = key.replace(/\/(\/+)/g, '/')

      // strip trailing slash
      if (key.endsWith('/')) {
        key = key.replace(/(\/+)$/, '')
      }

      let pathParts = key.split('/')

      if (key.startsWith('/ipfs/')) {
        pathParts = pathParts.slice(2)
      }

      const ipfs = await getIpfs()
      let first = true
      let cidWidth = 0
      let sizeWidth = 0

      const printLink = (cid, size, name, depth = 0) => {
        // todo: fix this by resolving https://github.com/ipfs/js-ipfs-unixfs-exporter/issues/24
        const padding = Math.max(depth - pathParts.length, 0)
        print(
          rightpad(cid, cidWidth + 1) +
          rightpad(size || '-', sizeWidth + 1) +
          '  '.repeat(padding) + name
        )
      }

      for await (const link of ipfs.ls(key, { recursive })) {
        const cid = cidToString(link.cid, { base: cidBase })
        const name = link.type === 'dir' ? `${link.name || ''}/` : link.name

        cidWidth = Math.max(cidWidth, cid.length)
        sizeWidth = Math.max(sizeWidth, String(link.size).length)

        if (first) {
          first = false
          if (headers) {
            cidWidth = Math.max(cidWidth, 'Hash'.length)
            sizeWidth = Math.max(sizeWidth, 'Size'.length)
            printLink('Hash', 'Size', 'Name')
          }
        }

        printLink(cid, link.size, name, link.depth)
      }
    })())
  }
}
