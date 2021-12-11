import { startTelemetryClient, nodeBlockInfoSubject } from './telemetry';
import { notify } from './notifier';
import { NodeBlockInfo } from "./telemetry/connection";
const { providePolkadotApi, performFailover } = require('./polkadot')

const telemetryTimeout = 20000; // in ms

type NodeState = {
  sessionKey: string,
  block?: number,
  nodeName?: string,
  active?: boolean,
  account?: string
}

/**
 * This microservice should every X minutes to check and, if necessary,
 * perfom a failover routine for our Moonriver nodes
 */
exports.handler = async () => {

  try {

    console.log('Get ENV variables')

    // TELEMETRY_URL
    // your private telemetry url, defaults to public telemetry url
    
    // TESTING_MODE
    // when set to "true", the reassociation extrinsic will not be executed on chain

    // BLOCK_LAG_THRESHOLD
    // If a node's current imported block is more than blockLagThreshold blocks behind that current height, then perform failover 
    const blockLagThreshold = process.env.BLOCK_LAG_THRESHOLD ? +process.env.BLOCK_LAG_THRESHOLD : 20;
    
    // PROXY_SECRET_KEY
    // the (AuthorMapping) proxy secret key, starting with 0x
    const proxySecretKey = process.env.PROXY_SECRET_KEY
    
    // NODE_NETWORK_IDS
    // telemetry network IDs of our nodes separated by comma
    // the order of the IDs is also the order of preference as backup nodes, i.e. 1st, 2nd, etc.
    const nodeNetworkIDs = process.env.NODE_NETWORK_IDS ? process.env.NODE_NETWORK_IDS.split(',') : []
    
    // SESSION_KEYS
    // the node session keys of our nodes separated by comma, in the same order
    const sessionKeys = process.env.SESSION_KEYS ? process.env.SESSION_KEYS.split(','): []
    if (nodeNetworkIDs.length == 0 || sessionKeys.length == 0 || nodeNetworkIDs.length != sessionKeys.length) {
      console.error('Check the provided network ids and session keys')
      // return
    }

    console.log('Prepare node state data structure')
    const nodeState: {
      [key: string]: NodeState
    } = {};
    for (let i = 0; i < nodeNetworkIDs.length; i++) {
      nodeState[nodeNetworkIDs[i]] = {
        sessionKey: sessionKeys[i]
      }
    }

    console.log('Connect to moonriver network')
    const polkadotApi = await providePolkadotApi();
    await polkadotApi.isReady;
    // Necessary hack to allow polkadotApi to finish its internal metadata loading
    // apiPromise.isReady unfortunately doesn't wait for those properly
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });

    console.log('Get current block number of each one of our nodes from telemetry')
    // Note that, the private telemetry keeps a record of deactivated or stalled nodes;
    // therefore, we will get block numbers even for nodes that have "disconnected" or shut down.
    // If, however, the telemetry server was reset, the disconnected nodes will not show.
    let timedOut = false;
    let nodeCount = 0;
    await new Promise(async (resolve, reject) => {
      startTelemetryClient()
      let lastAddedNodeTime: number;
      nodeBlockInfoSubject.subscribe((data: NodeBlockInfo) => {
        // console.log(data)
        if (nodeState[data.networkID]) {
          nodeState[data.networkID].block = data.block
          nodeState[data.networkID].nodeName = data.nodeName
        }
        lastAddedNodeTime = +new Date()
        nodeCount++
      })
      // wait until there is no more data for at least two seconds, then resolve
      const timeout = setTimeout(() => {
        timedOut = true;
        reject()
      }, telemetryTimeout)
      const intervalID = setInterval(() => {
        if (lastAddedNodeTime && (+ new Date()) - lastAddedNodeTime > 2000) {
          console.log('Finished getting node data from telemetry')
          clearTimeout(timeout);
          clearInterval(intervalID);
          resolve(true);
        }
      }, 200)
    });

    if (timedOut || nodeCount == 0) {
      console.error('Telemetry connection timed out or zero nodes found');
      notify();
      return
    }

    console.log('Identify which node is actively collating (associated session key) from chain')
    // Get author mappings
    let authorMappings = await polkadotApi.query.authorMapping.mappingWithDeposit.multi(sessionKeys);
    const accounts = authorMappings.map(c => c && c.toHuman() ? c.toHuman()['account'] : undefined)
    for (let i = 0; i < accounts.length; i++) {
      if (accounts[i]) {
        nodeState[nodeNetworkIDs[i]].active = true
        nodeState[nodeNetworkIDs[i]].account = accounts[i]
      }
    }
    console.log(`Nodes state:\n${JSON.stringify(nodeState, null, 2)}`)

    console.log('Get current block height from chain')
    const lastHeader = await polkadotApi.rpc.chain.getHeader();
    const chainBlockHeight = +lastHeader.number;
    console.log(`Current chain block height is ${chainBlockHeight}`)

    console.log('Identify best backup node')
    // we find the highest priority, non-active (not associated), healthy backup node
    let firstNonActiveHealthyNode: NodeState | undefined;
    for (const networkID of nodeNetworkIDs) {
      const node = nodeState[networkID]
      if (!node) {
        continue
      }
      if (node.block && node.block >= chainBlockHeight - blockLagThreshold && !node.active && !firstNonActiveHealthyNode) {
        firstNonActiveHealthyNode = node
      }
    }
    if (!firstNonActiveHealthyNode) {
      console.error('Could not find a healthy backup node')
      notify()
      return;
    }
    console.log(`Selected backup node is ${firstNonActiveHealthyNode.nodeName}`)

    console.log('Compare block heights')
    for (const networkID in nodeState) {
      const node = nodeState[networkID]
      console.log(`${node.nodeName} block ${node.block} vs ${chainBlockHeight}`)
      // if the node is not found on telemetry (node went down, and telemetry server was reset)
      // or, if the node is lagging behind in blocks more than the set threshold
      if (!node.block || (node.block < chainBlockHeight - blockLagThreshold)) {
        if (node.active && node.account) {
          console.log('Active node not found on telemetry or is lagging. Will initiate re-association')
          const backupSessionKey = firstNonActiveHealthyNode.sessionKey
          // perform failover
          await performFailover(polkadotApi, proxySecretKey, node.account, node.sessionKey, backupSessionKey)
          console.log('Failover completed')
          notify()
        } else {
          console.log('Node not found on telemetry or is lagging.')
          notify()
        }
      }
    }

  } catch (e) {
    console.error(e)
    notify()
  }

  console.log('Finished')
}

