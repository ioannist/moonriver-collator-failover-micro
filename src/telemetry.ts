import { Maybe } from "./telemetry/common";
import { Connection, NodeBlockInfo } from "./telemetry/connection";
import WebSocket from 'ws';
import { Subject } from 'rxjs';

export const nodeBlockInfoSubject = new Subject<NodeBlockInfo>();

const moonRiverSHash: string = '0x401a1f9dca3da46f5c4091016c8a2f26dcea05865116b286f60f668207d1474b';
let socket: Maybe<WebSocket> = null;
let connection: Maybe<Connection> = null

async function handleDisconnect() {
    connection?.clean();
    socket?.close();
    socket = await Connection.socket();
    bindSocket();
}

async function bindSocket() {
    socket?.addEventListener('message', Connection.handleFeedData);
    socket?.addEventListener('close', handleDisconnect);
    socket?.addEventListener('error', handleDisconnect);
    // subscribe();
}

async function subscribe() {
    socket?.send(`subscribe:${moonRiverSHash}`);
    console.log('Subscribed to moonriver telemetry')
}

export async function startTelemetryClient() {
    socket = await Connection.socket();
    connection = await Connection.create(nodeBlockInfoSubject, socket, bindSocket);
    console.log('Socket connected')
    subscribe();
}