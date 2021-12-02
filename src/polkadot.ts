const { ApiPromise, WsProvider, Keyring } = require("@polkadot/api");
const { typesBundlePre900 } = require("moonbeam-types-bundle")

const proxyType = 'AuthorMapping';
const testingMode = process.env.TESTING_MODE == 'true'

export async function providePolkadotApi() {
    let api
    const wsEndpoints = [
        'wss://wss.moonriver.moonbeam.network',
        'wss://moonriver.api.onfinality.io/public-ws',
        'wss://moonriver.kusama.elara.patract.io'
    ]
    let wsIndex = 0;
    while (true) {
        try {
            const provider = new WsProvider(wsEndpoints[wsIndex % wsEndpoints.length]);
            await new Promise((resolve, reject) => {
                provider.on('connected', () => resolve(true));
                provider.on('disconnected', () => reject());
            });
            api = await ApiPromise.create({
                initWasm: false,
                provider,
                typesBundle: typesBundlePre900,
            });
            return api

        } catch (e) {
            console.log(e)
            wsIndex++
        }
    }
}

export async function performFailover(api, proxySecretKey, collatorAccount, oldSessionKey, newSessionKey) {
    console.log(`Performing failover for collator ${collatorAccount} from session key ${oldSessionKey} to ${newSessionKey}`)
    if (testingMode) {
        return
    }
    await new Promise(async (resolve, reject) => {
        const keyring = new Keyring({ type: "ethereum" });
        const proxy = keyring.addFromUri(proxySecretKey, undefined, "ethereum");
        const txUpdate = api.tx.authorMapping.updateAssociation(oldSessionKey, newSessionKey)
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
    })
}
