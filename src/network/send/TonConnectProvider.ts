import qrcode from 'qrcode-terminal';
import TonConnect, { IStorage, WalletInfo, WalletInfoRemote } from '@tonconnect/sdk';
import { Address, beginCell, Cell, StateInit, storeStateInit } from '@ton/core';
import { SendProvider } from './SendProvider';
import { Storage } from '../storage/Storage';
import { UIProvider } from '../../ui/UIProvider';

class TonConnectStorage implements IStorage {
    #inner: Storage;

    constructor(inner: Storage) {
        this.#inner = inner;
    }

    async setItem(key: string, value: string): Promise<void> {
        return await this.#inner.setItem(key, value);
    }
    async getItem(key: string): Promise<string | null> {
        return await this.#inner.getItem(key);
    }
    async removeItem(key: string): Promise<void> {
        return await this.#inner.removeItem(key);
    }
}

function isRemote(walletInfo: WalletInfo): walletInfo is WalletInfoRemote {
    return 'universalLink' in walletInfo && 'bridgeUrl' in walletInfo;
}

export class TonConnectProvider implements SendProvider {
    #connector: TonConnect;
    #ui: UIProvider;

    constructor(storage: Storage, ui: UIProvider) {
        this.#connector = new TonConnect({
            storage: new TonConnectStorage(storage),
            manifestUrl: 'https://raw.githubusercontent.com/ton-org/blueprint/main/tonconnect/manifest.json',
        });
        this.#ui = ui;
    }

    async connect(): Promise<void> {
        await this.connectWallet();
        this.#ui.write(
            `Connected to wallet at address: ${Address.parse(this.#connector.wallet!.account.address).toString()}\n`,
        );
    }

    address(): Address | undefined {
        if (!this.#connector.wallet) return undefined;

        return Address.parse(this.#connector.wallet.account.address);
    }

    private async connectWallet(): Promise<void> {
        const wallets = (await this.#connector.getWallets()).filter(isRemote);

        await this.#connector.restoreConnection();

        if (this.#connector.wallet) {
            return;
        }

        const wallet = await this.#ui.choose('Choose your wallet', wallets, (w) => w.name);

        this.#ui.setActionPrompt('Connecting to wallet...');

        const url = this.#connector.connect({
            universalLink: wallet.universalLink,
            bridgeUrl: wallet.bridgeUrl,
        }) as string;

        this.#ui.write('\n');

        qrcode.generate(url, { small: true }, (qr) => this.#ui.write(qr));

        this.#ui.write('\n' + url + '\n\n');

        this.#ui.setActionPrompt('Scan the QR code in your wallet or open the link...');

        return new Promise((resolve, reject) => {
            this.#connector.onStatusChange((w) => {
                if (w) {
                    resolve();
                } else {
                    reject('Wallet is not connected');
                }
            }, reject);
        });
    }

    async sendTransaction(address: Address, amount: bigint, payload?: Cell, stateInit?: StateInit) {
        this.#ui.setActionPrompt('Sending transaction. Approve in your wallet...');

        const result = await this.#connector.sendTransaction({
            validUntil: Date.now() + 5 * 60 * 1000,
            messages: [
                {
                    address: address.toString(),
                    amount: amount.toString(),
                    payload: payload?.toBoc().toString('base64'),
                    stateInit: stateInit
                        ? beginCell().storeWritable(storeStateInit(stateInit)).endCell().toBoc().toString('base64')
                        : undefined,
                },
            ],
        });

        this.#ui.clearActionPrompt();
        this.#ui.write('Sent transaction');

        return result;
    }
}
