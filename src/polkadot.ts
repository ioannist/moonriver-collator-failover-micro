const { ApiPromise, WsProvider, Keyring } = require("@polkadot/api");
const { typesBundleForPolkadot } = require("@moonbeam-network/types-bundle");
const { hexToU8a } = require("@polkadot/util");

const proxyType = 'AuthorMapping';
const testingMode = process.env.TESTING_MODE == 'true'

export async function providePolkadotApi() {
    let api
    if (!process.env.WS_ENDPOINTS) {
        throw new Error('WS_ENDPOINTS environment variable is required but not set');
    }
    const wsEndpoints = process.env.WS_ENDPOINTS.split(',');
    let wsIndex = 0;
    while (true) {
        try {
            const provider = new WsProvider(wsEndpoints[wsIndex % wsEndpoints.length]);
            await new Promise((resolve, reject) => {
                provider.on('connected', () => resolve(true));
                provider.on('disconnected', () => reject());
            });
            
            // Create API with explicit types and type overrides to ensure compatibility
            api = await ApiPromise.create({
                provider,
                typesBundle: typesBundleForPolkadot,
                noInitWarn: true
            });
            
            // Wait for API to be ready and connected
            await api.isReady;
            console.log(`Connected to ${wsEndpoints[wsIndex % wsEndpoints.length]}`);
            
            return api;
        } catch (e) {
            console.log(`Error connecting to ${wsEndpoints[wsIndex % wsEndpoints.length]}:`, e);
            wsIndex++;
            // If we've tried all endpoints, wait before retrying
            if (wsIndex >= wsEndpoints.length) {
                await new Promise(resolve => setTimeout(resolve, 5000));
            }
        }
    }
}

export async function performFailover(api, proxySecretKey, collatorAccount, oldSessionKey, newSessionKey) {
    console.log(`Performing failover for collator ${collatorAccount} from session key ${oldSessionKey} to ${newSessionKey}`)
    if (testingMode) {
        return
    }
    await new Promise(async (resolve, reject) => {
        try {
            const keyring = new Keyring({ type: "ethereum" });
            const proxy = keyring.addFromUri(proxySecretKey, undefined, "ethereum");
            
            // Clean the key - ensure it's a proper hex string
            // If it starts with 0x, keep it as is, otherwise add 0x prefix
            const cleanKey = newSessionKey.startsWith('0x') ? newSessionKey : `0x${newSessionKey}`;
            
            console.log(`Using session key: ${cleanKey}`);
            
            // Use the API to create the call correctly
            const txUpdate = api.tx.authorMapping.setKeys(cleanKey);
            
            api.tx.proxy
                .proxy(collatorAccount, proxyType, txUpdate)
                .signAndSend(proxy, ({ status, dispatchError }) => {
                    if (status.isInBlock) {
                        console.log(`Included in ${status.asInBlock}`);
                        resolve(true)
                    }
                    if (dispatchError) {
                        if (dispatchError.isModule) {
                            // for module errors, we have the section indexed, lookup
                            const decoded = api.registry.findMetaError(dispatchError.asModule);
                            const { docs, name, section } = decoded;
                            console.error(`${section}.${name}: ${docs.join(' ')}`);
                        } else {
                            // Other, CannotLookup, BadOrigin, no extra info
                            console.error(dispatchError.toString());
                        }
                        reject()
                    }
                })
        } catch (error) {
            console.error('Error in performFailover:', error);
            reject(error);
        }
    })
}
