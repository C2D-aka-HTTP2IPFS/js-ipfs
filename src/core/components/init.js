'use strict'

const log = require('debug')('ipfs:components:init')
const PeerId = require('peer-id')
const PeerInfo = require('peer-info')
const mergeOptions = require('merge-options')
const getDefaultConfig = require('../runtime/config-nodejs.js')
const createRepo = require('../runtime/repo-nodejs')
const Keychain = require('libp2p-keychain')
const NoKeychain = require('./no-keychain')
const mortice = require('mortice')
const { DAGNode } = require('ipld-dag-pb')
const UnixFs = require('ipfs-unixfs')
const multicodec = require('multicodec')
const multiaddr = require('multiaddr')
const {
  AlreadyInitializingError,
  AlreadyInitializedError,
  NotStartedError
} = require('../errors')
const BlockService = require('ipfs-block-service')
const Ipld = require('ipld')
const getDefaultIpldOptions = require('../runtime/ipld-nodejs')
const createPreloader = require('../preload')
const { ERR_REPO_NOT_INITIALIZED } = require('ipfs-repo').errors
const IPNS = require('../ipns')
const OfflineDatastore = require('../ipns/routing/offline-datastore')
const initAssets = require('../runtime/init-assets-nodejs')
const PinManager = require('./pin/pin-manager')
const Components = require('./')

module.exports = ({
  apiManager,
  print,
  options: constructorOptions
}) => async function init (options) {
  const { cancel } = apiManager.update({ init: () => { throw new AlreadyInitializingError() } })

  try {
    options = options || {}

    if (typeof constructorOptions.init === 'object') {
      options = mergeOptions(constructorOptions.init, options)
    }

    options.pass = options.pass || constructorOptions.pass

    if (constructorOptions.config) {
      options.config = mergeOptions(options.config, constructorOptions.config)
    }

    options.repo = options.repo || constructorOptions.repo

    const repo = typeof options.repo === 'string' || options.repo == null
      ? createRepo({ path: options.repo, autoMigrate: options.repoAutoMigrate })
      : options.repo

    let isInitialized = true

    if (repo.closed) {
      try {
        await repo.open()
      } catch (err) {
        if (err.code === ERR_REPO_NOT_INITIALIZED) {
          isInitialized = false
        } else {
          throw err
        }
      }
    }

    const { peerId, config, keychain } = isInitialized
      ? await initExistingRepo(repo, options)
      : await initNewRepo(repo, { ...options, print })

    log('peer created')
    const peerInfo = new PeerInfo(peerId)

    if (config.Addresses && config.Addresses.Swarm) {
      config.Addresses.Swarm.forEach(addr => {
        let ma = multiaddr(addr)

        if (ma.getPeerId()) {
          ma = ma.encapsulate(`/p2p/${peerInfo.id.toB58String()}`)
        }

        peerInfo.multiaddrs.add(ma)
      })
    }

    const blockService = new BlockService(repo)
    const ipld = new Ipld(getDefaultIpldOptions(blockService, constructorOptions.ipld, log))

    const preload = createPreloader(constructorOptions.preload)
    await preload.start()

    // Make sure GC lock is specific to repo, for tests where there are
    // multiple instances of IPFS
    const gcLock = mortice(repo.path, { singleProcess: constructorOptions.repoOwner })
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

    const pinManager = new PinManager(repo, dag)
    await pinManager.load()

    const pin = {
      add: Components.pin.add({ pinManager, gcLock, dag, object }),
      ls: Components.pin.ls({ pinManager, object }),
      rm: Components.pin.rm({ pinManager, gcLock, object })
    }

    // FIXME: resolve this circular dependency
    dag.put = Components.dag.put({ ipld, pin, gcLock, preload })

    const add = Components.add({ ipld, dag, preload, pin, gcLock, constructorOptions })

    if (!isInitialized && !options.emptyRepo) {
      // add empty unixfs dir object (go-ipfs assumes this exists)
      const emptyDirCid = await addEmptyDir({ dag })

      log('adding default assets')
      await initAssets({ add, print })

      log('initializing IPNS keyspace')
      // Setup the offline routing for IPNS.
      // This is primarily used for offline ipns modifications, such as the initializeKeyspace feature.
      const offlineDatastore = new OfflineDatastore(repo)
      const ipns = new IPNS(offlineDatastore, repo.datastore, peerInfo, keychain, { pass: options.pass })
      await ipns.initializeKeyspace(peerId.privKey.bytes, emptyDirCid.toString())
    }

    const api = createApi({
      add,
      apiManager,
      constructorOptions,
      blockService,
      dag,
      gcLock,
      initOptions: options,
      ipld,
      keychain,
      object,
      peerInfo,
      pin,
      pinManager,
      preload,
      print,
      repo
    })

    apiManager.update(api, () => { throw new NotStartedError() })
  } catch (err) {
    cancel()
    throw err
  }

  return apiManager.api
}

async function initNewRepo (repo, { privateKey, emptyRepo, bits, profiles, config, pass, print }) {
  emptyRepo = emptyRepo || false
  bits = bits == null ? 2048 : Number(bits)

  config = mergeOptions(getDefaultConfig(), config)
  config = applyProfiles(profiles, config)

  // Verify repo does not exist yet
  const exists = await repo.exists()
  log('repo exists?', exists)

  if (exists === true) {
    throw new Error('repo already exists')
  }

  const peerId = await createPeerId({ privateKey, bits, print })
  let keychain = new NoKeychain()

  log('identity generated')

  config.Identity = {
    PeerID: peerId.toB58String(),
    PrivKey: peerId.privKey.bytes.toString('base64')
  }

  privateKey = peerId.privKey

  config.Keychain = Keychain.generateOptions()

  log('peer identity: %s', config.Identity.PeerID)

  await repo.init(config)
  await repo.open()

  log('repo opened')

  if (pass) {
    log('creating keychain')
    const keychainOptions = { passPhrase: pass, ...config.Keychain }
    keychain = new Keychain(repo.keys, keychainOptions)
    await keychain.importPeer('self', { privKey: privateKey })
  }

  return { peerId, keychain, config }
}

async function initExistingRepo (repo, { config: newConfig, profiles, pass }) {
  let config = await repo.config.get()

  if (newConfig || profiles) {
    if (newConfig) {
      config = mergeOptions(config, newConfig)
    }
    if (profiles) {
      config = applyProfiles(profiles, config)
    }
    await repo.config.set(config)
  }

  let keychain = new NoKeychain()

  if (pass) {
    const keychainOptions = { passPhrase: pass, ...config.Keychain }
    keychain = new Keychain(repo.keys, keychainOptions)
    log('keychain constructed')
  }

  const peerId = await PeerId.createFromPrivKey(config.Identity.PrivKey)

  // Import the private key as 'self', if needed.
  if (pass) {
    try {
      await keychain.findKeyByName('self')
    } catch (err) {
      log('Creating "self" key')
      await keychain.importPeer('self', peerId)
    }
  }

  return { peerId, keychain, config }
}

function createPeerId ({ privateKey, bits, print }) {
  if (privateKey) {
    log('using user-supplied private-key')
    return typeof privateKey === 'object'
      ? privateKey
      : PeerId.createFromPrivKey(Buffer.from(privateKey, 'base64'))
  } else {
    // Generate peer identity keypair + transform to desired format + add to config.
    print('generating %s-bit RSA keypair...', bits)
    return PeerId.create({ bits })
  }
}

async function addEmptyDir ({ dag }) {
  const node = new DAGNode(new UnixFs('directory').marshal())
  return dag.put(node, {
    version: 0,
    format: multicodec.DAG_PB,
    hashAlg: multicodec.SHA2_256,
    preload: false
  })
}

// Apply profiles (e.g. ['server', 'lowpower']) to config
function applyProfiles (profiles, config) {
  return (profiles || []).reduce((config, name) => {
    const profile = require('./config').profiles[name]
    if (!profile) {
      throw new Error(`No profile with name '${name}'`)
    }
    log('applying profile %s', name)
    return profile.transform(config)
  }, config)
}

function createApi ({
  add,
  apiManager,
  constructorOptions,
  blockService,
  dag,
  gcLock,
  initOptions,
  ipld,
  keychain,
  object,
  peerInfo,
  pin,
  pinManager,
  preload,
  print,
  repo
}) {
  const refs = () => { throw new NotStartedError() }
  refs.local = Components.refs.local({ repo })

  const api = {
    add,
    bootstrap: {
      add: Components.bootstrap.add({ repo }),
      list: Components.bootstrap.list({ repo }),
      rm: Components.bootstrap.rm({ repo })
    },
    block: {
      get: Components.block.get({ blockService, preload }),
      put: Components.block.put({ blockService, gcLock, preload }),
      rm: Components.block.rm({ blockService, gcLock, pinManager }),
      stat: Components.block.stat({ blockService, preload })
    },
    cat: Components.cat({ ipld, preload }),
    config: Components.config({ repo }),
    dag,
    dns: Components.dns(),
    files: Components.files({ ipld, blockService, repo, preload, options: constructorOptions }),
    get: Components.get({ ipld, preload }),
    id: Components.id({ peerInfo }),
    init: () => { throw new AlreadyInitializedError() },
    isOnline: Components.isOnline({}),
    ls: Components.ls({ ipld, preload }),
    object,
    pin,
    refs,
    repo: {
      // TODO: gc should be available after init
      // `resolve` (passed to `refs` API) which is a dependency for `gc` API
      // needs to be altered to allow `name` API dependency to be optional, so
      // that `resolve` can also be available when not started, and so `gc` can
      // be run when not started.
      // gc: Commands.repo.gc({ gcLock, pin, pinManager, refs, repo }),
      stat: Components.repo.stat({ repo }),
      version: Components.repo.version({ repo })
    },
    start: Components.start({
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
    }),
    stats: {
      bitswap: () => { throw new NotStartedError() },
      bw: () => { throw new NotStartedError() },
      repo: Components.repo.stat({ repo })
    },
    stop: () => apiManager.api,
    swarm: {
      addrs: () => { throw new NotStartedError() },
      connect: () => { throw new NotStartedError() },
      disconnect: () => { throw new NotStartedError() },
      localAddrs: Components.swarm.localAddrs({ peerInfo }),
      peers: () => { throw new NotStartedError() }
    },
    version: Components.version({ repo })
  }

  return api
}
