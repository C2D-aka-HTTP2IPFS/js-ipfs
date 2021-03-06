/* eslint max-nested-callbacks: ["error", 8] */
/* eslint-env mocha */
'use strict'

const { expect } = require('interface-ipfs-core/src/utils/mocha')
const pull = require('pull-stream')
const factory = require('../utils/factory')

describe('stats', function () {
  const df = factory()
  this.timeout(10 * 1000)
  let ipfsd, ipfs

  before(async () => {
    ipfsd = await df.spawn()
    ipfs = ipfsd.api
  })

  after(() => df.clean())

  describe('bwPullStream', () => {
    it('should return erroring stream for invalid interval option', (done) => {
      pull(
        ipfs.stats.bwPullStream({ poll: true, interval: 'INVALID INTERVAL' }),
        pull.collect((err) => {
          expect(err).to.exist()
          expect(err.code).to.equal('ERR_INVALID_POLL_INTERVAL')
          done()
        })
      )
    })
  })

  describe('bw', () => {
    it('should not error when passed null options', (done) => {
      ipfs.stats.bw(null, (err) => {
        expect(err).to.not.exist()
        done()
      })
    })
  })
})
