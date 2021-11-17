import { WalletNotConnectedError, WalletNotReadyError } from '@solana/wallet-adapter-base';
import type {
    MessageSignerWalletAdapter,
    MessageSignerWalletAdapterProps,
    SendTransactionOptions,
    SignerWalletAdapter,
    SignerWalletAdapterProps,
    WalletError,
} from '@solana/wallet-adapter-base';
import type { Wallet, WalletName } from '@solana/wallet-adapter-wallets';
import type { Connection, PublicKey, Transaction, TransactionSignature } from '@solana/web3.js';
import { get, writable } from 'svelte/store';
import { WalletNotSelectedError } from './errors';
import { getLocalStorage, setLocalStorage } from './localStorage';

type Adapter = ReturnType<Wallet['adapter']>;
type ErrorHandler = (error: WalletError) => void;
type WalletDictionary = { [name in WalletName]: Wallet };
type WalletConfig = Pick<WalletStore,
    'wallets' | 'walletsByName' | 'autoConnect' | 'localStorageKey' | 'onError'>;
type WalletStatus = Pick<WalletStore, 'ready' | 'connected' | 'publicKey'>

interface WalletStore {
    autoConnect: boolean;
    wallets: Wallet[];

    adapter: Adapter | null;
    connected: boolean;
    connecting: boolean;
    disconnecting: boolean;
    localStorageKey: string;
    onError: ErrorHandler;
    publicKey: PublicKey | null;
    ready: boolean;
    wallet: Wallet | null;
    walletsByName: WalletDictionary;
    walletName: WalletName | null;

    connect(): Promise<void>;

    disconnect(): Promise<void>;

    select(walletName: WalletName): void;

    sendTransaction(
        transaction: Transaction,
        connection: Connection,
        options?: SendTransactionOptions,
    ): Promise<TransactionSignature>;

    signAllTransactions: SignerWalletAdapterProps['signAllTransactions'] | undefined;
    signMessage: MessageSignerWalletAdapterProps['signMessage'] | undefined;
    signTransaction: SignerWalletAdapterProps['signTransaction'] | undefined;
}

export const walletStore = createWalletStore();

function addAdapterEventListeners(adapter: Adapter) {
    const { onError } = get(walletStore);

    adapter.on('ready', onReady);
    adapter.on('connect', onConnect);
    adapter.on('disconnect', onDisconnect);
    adapter.on('error', onError);
}

async function autoConnect() {
    const { adapter } = get(walletStore);

    try {
        walletStore.setConnecting(true);
        await adapter?.connect();
    } catch (error: unknown) {
        // Clear the selected wallet
        walletStore.resetWallet();
        // Don't throw error, but onError will still be called
    } finally {
        walletStore.setConnecting(false);
    }
}

async function connect(): Promise<void> {
    const { connected, connecting, disconnecting, wallet, ready, adapter } = get(walletStore);
    if (connected || connecting || disconnecting) return;

    if (!wallet || !adapter) throw newError(new WalletNotSelectedError());

    if (!ready) {
        walletStore.resetWallet();
        window.open(wallet.url, '_blank');
        throw newError(new WalletNotReadyError());
    }

    try {
        walletStore.setConnecting(true);
        await adapter.connect();
    } catch (error: unknown) {
        walletStore.resetWallet();
        throw error;
    } finally {
        walletStore.setConnecting(false);
    }
}

function createWalletStore() {
    const { subscribe, update } = writable<WalletStore>({
        autoConnect: false,
        wallets: [],
        adapter: null,
        connected: false,
        connecting: false,
        disconnecting: false,
        localStorageKey: 'walletAdapter',
        onError: (error: WalletError) => console.error(error),
        publicKey: null,
        ready: false,
        wallet: null,
        walletName: null,
        walletsByName: {} as WalletDictionary,
        connect,
        disconnect,
        select,
        sendTransaction,
        signTransaction: undefined,
        signAllTransactions: undefined,
        signMessage: undefined,
    });

    function updateWalletState(wallet: Wallet | null, adapter: Adapter | null) {
        updateAdapter(adapter);
        update((store) => ({
            ...store,
            walletName: wallet?.name || null,
            wallet,
            ready: adapter?.ready || false,
            publicKey: adapter?.publicKey || null,
            connected: adapter?.connected || false,
        }));
    }

    function updateWalletName(walletName: WalletName | null) {
        const { localStorageKey, walletsByName } = get(walletStore);

        const wallet = walletsByName?.[walletName as WalletName] ?? null;
        const adapter = wallet?.adapter() ?? null;

        setLocalStorage(localStorageKey, walletName);
        updateWalletState(wallet, adapter);
    }

    function updateAdapter(adapter: Adapter | null) {
        removeAdapterEventListeners();

        let signTransaction: SignerWalletAdapter['signTransaction'] | undefined = undefined;
        let signAllTransactions: SignerWalletAdapter['signAllTransactions'] | undefined = undefined;
        let signMessage: MessageSignerWalletAdapter['signMessage'] | undefined = undefined;

        if (adapter) {
            // Sign a transaction if the wallet supports it
            if ('signTransaction' in adapter) {
                signTransaction = async function(transaction: Transaction) {
                    const { connected } = get(walletStore);
                    if (!connected) throw newError(new WalletNotConnectedError());
                    return await adapter.signTransaction(transaction);
                };
            }

            // Sign multiple transactions if the wallet supports it
            if ('signAllTransactions' in adapter) {
                signAllTransactions = async function(transactions: Transaction[]) {
                    const { connected } = get(walletStore);
                    if (!connected) throw newError(new WalletNotConnectedError());
                    return await adapter.signAllTransactions(transactions);
                };
            }

            // Sign an arbitrary message if the wallet supports it
            if ('signMessage' in adapter) {
                signMessage = async function(message: Uint8Array) {
                    const { connected } = get(walletStore);
                    if (!connected) throw newError(new WalletNotConnectedError());
                    return await adapter.signMessage(message);
                };
            }

            addAdapterEventListeners(adapter);
        }

        update((store) => ({ ...store, adapter, signTransaction, signAllTransactions, signMessage }));

        if (shouldAutoConnect()) {
            autoConnect();
        }
    }

    return {
        resetWallet: () => updateWalletName(null),
        setConnecting: (connecting: boolean) => update((store) => ({ ...store, connecting })),
        setDisconnecting: (disconnecting: boolean) => update((store) => ({ ...store, disconnecting })),
        setReady: (ready: boolean) => update((store) => ({ ...store, ready })),
        subscribe,
        updateConfig: (walletConfig: WalletConfig) =>
            update((store) => ({
                ...store,
                ...walletConfig,
            })),
        updateStatus: (walletStatus: WalletStatus) => update((store) => ({ ...store, ...walletStatus })),
        updateWallet: (walletName: WalletName) => updateWalletName(walletName),
    };
}

async function disconnect(): Promise<void> {
    const { disconnecting, adapter } = get(walletStore);
    if (disconnecting) return;

    if (!adapter) {
        return walletStore.resetWallet();
    }

    try {
        walletStore.setDisconnecting(true);
        await adapter.disconnect();
    } finally {
        walletStore.resetWallet();
        walletStore.setDisconnecting(false);
    }
}

export async function initialize({
     wallets,
     autoConnect = false,
     localStorageKey = 'walletAdapter',
     onError = (error: WalletError) => console.error(error),
 }: WalletConfig): Promise<void> {
    const walletsByName = wallets.reduce((walletsByName, wallet) => {
        walletsByName[wallet.name] = wallet;
        return walletsByName;
    }, {} as WalletDictionary);

    walletStore.updateConfig({
        wallets,
        walletsByName,
        autoConnect,
        localStorageKey,
        onError,
    });

    const walletName = getLocalStorage<WalletName>(localStorageKey);

    if (walletName) {
        walletStore.updateWallet(walletName);
    }
}

function newError(error: WalletError): WalletError {
    const { onError } = get(walletStore);
    onError(error);
    return error;
}

function onConnect() {
    const { adapter, wallet } = get(walletStore);
    if (!adapter || !wallet) return;

    walletStore.updateStatus({
        ready: adapter.ready,
        publicKey: adapter.publicKey,
        connected: adapter.connected,
    });
}

function onDisconnect() {
    walletStore.resetWallet();
}

function onReady() {
    walletStore.setReady(true);
}

function removeAdapterEventListeners(): void {
    const { adapter, onError } = get(walletStore);
    if (!adapter) return;

    adapter.off('ready', onReady);
    adapter.off('connect', onConnect);
    adapter.off('disconnect', onDisconnect);
    adapter.off('error', onError);
}

async function select(newName: WalletName): Promise<void> {
    const { walletName, adapter } = get(walletStore);
    if (walletName === newName) return;

    if (adapter) await disconnect();

    walletStore.updateWallet(newName);
}

async function sendTransaction(
    transaction: Transaction,
    connection: Connection,
    options?: SendTransactionOptions,
): Promise<TransactionSignature> {
    const { connected, adapter } = get(walletStore);
    if (!connected) throw newError(new WalletNotConnectedError());
    if (!adapter) throw newError(new WalletNotSelectedError());

    return await adapter.sendTransaction(transaction, connection, options);
}

function shouldAutoConnect(): boolean {
    const { adapter, autoConnect, ready, connected, connecting } = get(walletStore);

    return !(!autoConnect || !adapter || !ready || connected || connecting);
}

if (typeof window !== 'undefined') {
    // Ensure the adapter listeners are invalidated before refreshing the page.
    window.addEventListener('beforeunload', removeAdapterEventListeners);
}