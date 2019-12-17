'use strict'

const multibase = require('multibase')
const { cidToString } = require('../../../utils/cid')

module.exports = {
  // bracket syntax with '...' tells yargs to optionally accept a list
  command: 'ls [ipfsPath...]',

  describe: 'List objects pinned to local storage.',

  builder: {
    type: {
      type: 'string',
      alias: 't',
      default: 'all',
      choices: ['direct', 'indirect', 'recursive', 'all'],
      describe: 'The type of pinned keys to list.'
    },
    quiet: {
      type: 'boolean',
      alias: 'q',
      default: false,
      describe: 'Write just hashes of objects.'
    },
    'cid-base': {
      describe: 'Number base to display CIDs in.',
      type: 'string',
      choices: multibase.names
    }
  },

  handler: ({ getIpfs, print, ipfsPath, type, quiet, cidBase, resolve }) => {
    resolve((async () => {
      const paths = ipfsPath
      const ipfs = await getIpfs()
      for await (const res of ipfs.pin.ls(paths, { type })) {
        let line = cidToString(res.cid, { base: cidBase })
        if (!quiet) {
          line += ` ${res.type}`
        }
        print(line)
      }
    })())
  }
}
