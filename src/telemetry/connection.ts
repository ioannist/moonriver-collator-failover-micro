// Source code for the Substrate Telemetry Server.
// Copyright (C) 2021 Parity Technologies (UK) Ltd.
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program. If not, see <https://www.gnu.org/licenses/>.

import { VERSION, timestamp, FeedMessage, Types, Maybe, sleep, SortedCollection } from './common';
import { Node } from './state';
import { ACTIONS } from './common/feed';
import WebSocket from 'ws';
import { Subject } from 'rxjs';

const TIMEOUT_BASE = (1000 * 5) as Types.Milliseconds; // 5 seconds
const TIMEOUT_MAX = (1000 * 60 * 5) as Types.Milliseconds; // 5 minutes
const nodes = new SortedCollection(Node.compare);

export type NodeBlockInfo = {
  networkID: string,
  nodeName: string,
  block: number
}

export class Connection {

  static nodeBlockInfoSubject: Subject<NodeBlockInfo> = new Subject()

  public static async create(
    nodeBlockInfoSub: Subject<NodeBlockInfo>,
    socket: WebSocket,
    binSocketFunction?: Maybe<Function>
  ): Promise<Connection> {
    Connection.nodeBlockInfoSubject = nodeBlockInfoSub
    return new Connection(socket, binSocketFunction);
  }
  private static readonly utf8decoder = new TextDecoder('utf-8');
  private static readonly address = Connection.getAddress();


  private static getAddress(): string {
    return process.env.TELEMETRY_URL || 'wss://telemetry.polkadot.io/feed/'
  }

  public static async socket(): Promise<WebSocket> {
    let socket = await Connection.trySocket();
    let timeout = TIMEOUT_BASE;

    while (!socket) {
      await sleep(timeout);

      timeout = Math.min(timeout * 2, TIMEOUT_MAX) as Types.Milliseconds;
      socket = await Connection.trySocket();
    }

    return socket;
  }

  private static async trySocket(): Promise<Maybe<WebSocket>> {
    return new Promise<Maybe<WebSocket>>((resolve, _) => {
      function clean() {
        socket.removeEventListener('open', onSuccess);
        socket.removeEventListener('close', onFailure);
        socket.removeEventListener('error', onFailure);
      }

      function onSuccess() {
        clean();
        resolve(socket);
      }

      function onFailure() {
        clean();
        resolve(null);
      }
      const socket = new WebSocket(Connection.address);

      socket.binaryType = 'arraybuffer';
      socket.addEventListener('open', onSuccess);
      socket.addEventListener('error', onFailure);
      socket.addEventListener('close', onFailure);
    });
  }

  private pingId = 0;
  private pingTimeout: NodeJS.Timer;
  private pingSent: Maybe<Types.Timestamp> = null;

  public handleDisconnect: VoidFunction = async () => {
    this.clean();
    this.socket.close();
    this.socket = await Connection.socket();
    this.bindSocket();
  };

  private bindSocket: Function = (_socket: WebSocket, _handleFeedData?: Maybe<VoidFunction>, _handleDisconnect?: Maybe<VoidFunction>) => {
    this.ping();
    this.socket.addEventListener('message', Connection.handleFeedData);
    this.socket.addEventListener('close', this.handleDisconnect);
    this.socket.addEventListener('error', this.handleDisconnect);
  }

  public static handleFeedData = (event?: MessageEvent) => {
    let data: FeedMessage.Data;
    if (!event) return

    if (typeof event.data === 'string') {
      data = (event.data as any) as FeedMessage.Data;
    } else {
      const u8aData = new Uint8Array(event.data);

      // Future-proofing for when we switch to binary feed
      if (u8aData[0] === 0x00) {
        // return this.newVersion();
      }

      const str = Connection.utf8decoder.decode(event.data);

      data = (str as any) as FeedMessage.Data;
    }

    Connection.handleMessages(FeedMessage.deserialize(data));
  };

  constructor(public socket: WebSocket, bindSocketFunction?: Maybe<Function>) {
    if (bindSocketFunction) this.bindSocket = bindSocketFunction
    this.bindSocket(socket);
  }

  public unsubscribeConsensus(chain: String) {
    this.socket.send(`no-more-finality:${chain}`);
  }

  public static handleMessages = (messages: FeedMessage.Message[]) => {
    for (const message of messages) {
      switch (message.action) {
        case ACTIONS.FeedVersion: {
          if (message.payload !== VERSION) {
            // return this.newVersion();
          }
          break;
        }

        case ACTIONS.BestBlock: {
          const [best, blockTimestamp, blockAverage] = message.payload;

          nodes.mutEach((node) => node.newBestBlock());

          // this.appUpdate({ best, blockTimestamp, blockAverage });
          //console.log('BestBlock: \n\t', best, blockTimestamp, blockAverage)

          break;
        }

        case ACTIONS.BestFinalized: {
          const [finalized /*, hash */] = message.payload;

          // this.appUpdate({ finalized });
          //console.log('BestFinalized: \n\t', finalized)
          break;
        }

        case ACTIONS.AddedNode: {
          const [
            id,
            nodeDetails,
            nodeStats,
            nodeIO,
            nodeHardware,
            blockDetails,
            location,
            startupTime,
          ] = message.payload;
          const node = new Node(
            false,
            id,
            nodeDetails,
            nodeStats,
            nodeIO,
            nodeHardware,
            blockDetails,
            location,
            startupTime
          );

          nodes.add(node);
          /*console.log(
            'AddedNode: \n\t',
            {
              id,
              nodeDetails,
              nodeStats,
              nodeIO,
              nodeHardware,
              blockDetails,
              location,
              startupTime
            }
          );*/
          Connection.nodeBlockInfoSubject.next({
            networkID: nodeDetails[4] ? nodeDetails[4] : '',
            nodeName: nodeDetails[0] ? nodeDetails[0] : '',
            block: blockDetails[0] ? blockDetails[0] : 0
          })

          break;
        }

        case ACTIONS.RemovedNode: {
          const id = message.payload;

          nodes.remove(id);
          console.log('RemovedNode: \n\t', id);
          break;
        }

        case ACTIONS.StaleNode: {
          const id = message.payload;

          nodes.mutAndSort(id, (node) => node.setStale(true));
          // console.log('StaleNode: \n\t', id);
          break;
        }

        case ACTIONS.LocatedNode: {
          const [id, lat, lon, city] = message.payload;

          nodes.mutAndMaybeSort(
            id,
            (node) => node.updateLocation([lat, lon, city]),
            false
          );
          //console.log('LocatedNode: \n\t', id, lat, lon, city)
          break;
        }

        case ACTIONS.ImportedBlock: {
          const [id, blockDetails] = message.payload;

          nodes.mutAndSort(id, (node) => node.updateBlock(blockDetails));
          //console.log('ImportedBlock: \n\t', id, blockDetails);
          break;
        }

        case ACTIONS.FinalizedBlock: {
          const [id, height, hash] = message.payload;

          nodes.mutAndMaybeSort(
            id,
            (node) => node.updateFinalized(height, hash),
            false
          );
          //console.log('FinalizedBlock: \n\t', id, height, hash);
          break;
        }

        case ACTIONS.NodeStats: {
          const [id, nodeStats] = message.payload;

          nodes.mutAndMaybeSort(
            id,
            (node) => node.updateStats(nodeStats),
            false
          );
          //console.log('NodeStats: \n\t', id, nodeStats);
          break;
        }

        case ACTIONS.NodeHardware: {
          const [id, nodeHardware] = message.payload;

          nodes.mutAndMaybeSort(
            id,
            (node) => node.updateHardware(nodeHardware),
            false
          );
          //console.log('NodeHardware: \n\t', id, nodeHardware);
          break;
        }

        case ACTIONS.NodeIO: {
          const [id, nodeIO] = message.payload;

          nodes.mutAndMaybeSort(
            id,
            (node) => node.updateIO(nodeIO),
            false
          );
          //console.log('NodeIO: \n\t', id, nodeIO);
          break;
        }

        case ACTIONS.TimeSync: {
          //console.log('TimeSync: \n\t', (timestamp() - message.payload) as Types.Milliseconds);
          break;
        }

        case ACTIONS.AddedChain: {
          const [label, genesisHash, nodeCount] = message.payload;
          //console.log('AddedChain: \n\t', label, genesisHash, nodeCount);

          break;
        }

        case ACTIONS.RemovedChain: {
          // chains.delete(message.payload);

          // if (this.appState.subscribed === message.payload) {
          //   nodes.clear();
          //   this.appUpdate({ subscribed: null, nodes, chains });
          //   this.resetConsensus();
          // }
          //console.log('RemovedChain: \n\t', message.payload);
          break;
        }

        case ACTIONS.SubscribedTo: {
          // nodes.clear();

          // this.appUpdate({ subscribed: message.payload, nodes });
          console.log('SubscribedTo: \n\t', message.payload);

          break;
        }

        case ACTIONS.UnsubscribedFrom: {
          // if (this.appState.subscribed === message.payload) {
          //   nodes.clear();

          //   this.appUpdate({ subscribed: null, nodes });
          // }
          console.log('UnsubscribedFrom: \n\t', message.payload);
          break;
        }

        case ACTIONS.Pong: {
          // this.pong(Number(message.payload));
          // curius keep alive.
          break;
        }

        case ACTIONS.AfgFinalized: {
          const [nodeAddress, finalizedNumber, finalizedHash] = message.payload;
          const no = parseInt(String(finalizedNumber), 10) as Types.BlockNumber;
          // afg.receivedFinalized(nodeAddress, no, finalizedHash);
          console.log('AfgFinalized: \n\t', nodeAddress, no, finalizedHash);
          break;
        }

        case ACTIONS.AfgReceivedPrevote: {
          const [nodeAddress, blockNumber, blockHash, voter] = message.payload;
          const no = parseInt(String(blockNumber), 10) as Types.BlockNumber;
          // afg.receivedPre(nodeAddress, no, voter, 'prevote');
          console.log('AfgReceivedPrevote: \n\t', nodeAddress, no, voter, 'prevote');
          break;
        }

        case ACTIONS.AfgReceivedPrecommit: {
          const [nodeAddress, blockNumber, blockHash, voter] = message.payload;
          const no = parseInt(String(blockNumber), 10) as Types.BlockNumber;
          // afg.receivedPre(nodeAddress, no, voter, 'precommit');
          console.log('AfgReceivedPrecommit: \n\t', nodeAddress, no, voter, 'precommit');
          break;
        }

        case ACTIONS.AfgAuthoritySet: {
          const [authoritySetId, authorities] = message.payload;
          // afg.receivedAuthoritySet(authoritySetId, authorities);
          console.log('AfgAuthoritySet: \n\t', authoritySetId, authorities);
          break;
        }

        default: {
          break;
        }
      }
    }
  };

  private ping = () => {
    if (this.pingSent) {
      this.handleDisconnect();
      return;
    }

    this.pingId += 1;
    this.pingSent = timestamp();
    this.socket.send(`ping:${this.pingId}`);

    this.pingTimeout = setTimeout(this.ping, 30000);
  };

  public clean() {
    clearTimeout(this.pingTimeout);
    this.pingSent = null;

    this.socket.removeEventListener('message', Connection.handleFeedData);
    this.socket.removeEventListener('close', this.handleDisconnect);
    this.socket.removeEventListener('error', this.handleDisconnect);
  }
}
