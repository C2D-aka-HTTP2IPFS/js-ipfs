'use strict'

const Bitswap = require('ipfs-bitswap')
const IPNS = require('../ipns')
const routingConfig = require('../ipns/routing/config')
const defer = require('p-defer')
const { AlreadyInitializedError, NotEnabledError } = require('../errors')
const Components = require('./')

module.exports = ({
  apiManager,
  options: constructorOptions,
  blockService,
  gcLock,
  initOptions,
  ipld,
  keychain,
  peerInfo,
  pinManager,
  preload,
  print,
  repo
}) => async function start () {
  const startPromise = defer()
  const { cancel } = apiManager.update({ start: () => startPromise.promise })

  try {
    // The repo may be closed if previously stopped
    if (repo.closed) {
      await repo.open()
    }

    const config = await repo.config.get()

    const libp2p = Components.libp2p({
      options: constructorOptions,
      repo,
      peerInfo,
      print,
      config
    })

    await libp2p.start()

    const ipnsRouting = routingConfig({
      _options: constructorOptions,
      libp2p,
      _repo: repo,
      _peerInfo: peerInfo
    })
    const ipns = new IPNS(ipnsRouting, repo.datastore, peerInfo, keychain, { pass: initOptions.pass })
    const bitswap = new Bitswap(libp2p, repo.blocks, { statsEnabled: true })

    await bitswap.start()

    blockService.setExchange(bitswap)

    await preload.start()
    await ipns.republisher.start()
    // TODO: start mfs preload here

    const api = createApi({
      apiManager,
      bitswap,
      constructorOptions,
      blockService,
      gcLock,
      initOptions,
      ipld,
      ipns,
      keychain,
      libp2p,
      peerInfo,
      pinManager,
      preload,
      print,
      repo
    })

    apiManager.update(api, () => undefined)
  } catch (err) {
    cancel()
    startPromise.reject(err)
    throw err
  }

  startPromise.resolve(apiManager.api)
  return apiManager.api
}

function createApi ({
  apiManager,
  bitswap,
  constructorOptions,
  blockService,
  gcLock,
  initOptions,
  ipld,
  ipns,
  keychain,
  libp2p,
  peerInfo,
  pinManager,
  preload,
  print,
  repo
}) {
  const dag = {
    get: Components.dag.get({ ipld, preload }),
    resolve: Components.dag.resolve({ ipld, preload }),
    tree: Components.dag.tree({ ipld, preload })
  }
  const object = {
    data: Components.object.data({ ipld, preload }),
    get: Components.object.get({ ipld, preload }),
    links: Components.object.links({ dag }),
    new: Components.object.new({ ipld, preload }),
    patch: {
      addLink: Components.object.patch.addLink({ ipld, gcLock, preload }),
      appendData: Components.object.patch.appendData({ ipld, gcLock, preload }),
      rmLink: Components.object.patch.rmLink({ ipld, gcLock, preload }),
      setData: Components.object.patch.setData({ ipld, gcLock, preload })
    },
    put: Components.object.put({ ipld, gcLock, preload }),
    stat: Components.object.stat({ ipld, preload })
  }
  const pin = {
    add: Components.pin.add({ pinManager, gcLock, dag, object }),
    ls: Components.pin.ls({ pinManager, object }),
    rm: Components.pin.rm({ pinManager, gcLock, object })
  }
  // FIXME: resolve this circular dependency
  dag.put = Components.dag.put({ ipld, pin, gcLock, preload })
  const add = Components.add({ ipld, dag, preload, pin, gcLock, options: constructorOptions })
  const isOnline = Components.isOnline({ libp2p })
  const dns = Components.dns()
  const name = {
    pubsub: {
      cancel: Components.name.pubsub.cancel({ ipns, options: constructorOptions }),
      state: Components.name.pubsub.state({ ipns, options: constructorOptions }),
      subs: Components.name.pubsub.subs({ ipns, options: constructorOptions })
    },
    publish: Components.name.publish({ ipns, dag, peerInfo, isOnline, keychain, options: constructorOptions }),
    resolve: Components.name.resolve({ dns, ipns, peerInfo, isOnline, options: constructorOptions })
  }
  const resolve = Components.resolve({ name, ipld })
  const refs = Components.refs({ ipld, resolve, preload })
  refs.local = Components.refs.local({ repo })

  const api = {
    add,
    bitswap: {
      stat: Components.bitswap.stat({ bitswap }),
      unwant: Components.bitswap.unwant({ bitswap }),
      wantlist: Components.bitswap.wantlist({ bitswap })
    },
    block: {
      get: Components.block.get({ blockService, preload }),
      put: Components.block.put({ blockService, gcLock, preload }),
      rm: Components.block.rm({ blockService, gcLock, pinManager }),
      stat: Components.block.stat({ blockService, preload })
    },
    bootstrap: {
      add: Components.bootstrap.add({ repo }),
      list: Components.bootstrap.list({ repo }),
      rm: Components.bootstrap.rm({ repo })
    },
    cat: Components.cat({ ipld, preload }),
    config: Components.config({ repo }),
    dag,
    dns,
    files: Components.files({ ipld, blockService, repo, preload, options: constructorOptions }),
    get: Components.get({ ipld, preload }),
    id: Components.id({ peerInfo }),
    init: () => { throw new AlreadyInitializedError() },
    ls: Components.ls({ ipld, preload }),
    name,
    object,
    pin,
    ping: Components.ping({ libp2p }),
    pubsub: libp2p.pubsub
      ? Components.pubsub({ libp2p })
      : () => { throw new NotEnabledError('pubsub not enabled') },
    refs,
    repo: {
      // TODO: this PR depends on `refs` refactor and the `pins` refactor
      // https://github.com/ipfs/js-ipfs/pull/2658
      // https://github.com/ipfs/js-ipfs/pull/2660
      // gc: Commands.repo.gc({ gcLock, pin, pinManager, refs, repo }),
      stat: Components.repo.stat({ repo }),
      version: Components.repo.version({ repo })
    },
    resolve,
    start: () => apiManager.api,
    stats: {
      bitswap: Components.bitswap.stat({ bitswap }),
      bw: Components.stats.bw({ libp2p }),
      repo: Components.repo.stat({ repo })
    },
    stop: Components.stop({
      apiManager,
      bitswap,
      options: constructorOptions,
      blockService,
      gcLock,
      initOptions,
      ipld,
      ipns,
      keychain,
      libp2p,
      peerInfo,
      preload,
      print,
      repo
    }),
    swarm: {
      addrs: () => Components.swarm.addrs({ libp2p }),
      connect: () => Components.swarm.connect({ libp2p }),
      disconnect: () => Components.swarm.disconnect({ libp2p }),
      localAddrs: Components.swarm.localAddrs({ peerInfo }),
      peers: () => Components.swarm.peers({ libp2p })
    },
    version: Components.version({ repo })
  }

  return api
}
