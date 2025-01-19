import {
    WalletContractV1R1,
    WalletContractV1R2,
    WalletContractV1R3,
    WalletContractV2R1,
    WalletContractV2R2,
    WalletContractV3R1,
    WalletContractV3R2,
    WalletContractV4,
    WalletContractV5R1,
} from '@ton/ton';
import {
    Address,
    Cell,
    Contract,
    ContractProvider,
    MessageRelaxed,
    openContract,
    OpenedContract,
    SendMode,
    StateInit,
} from '@ton/core';
import { SendProvider } from './SendProvider';
import { keyPairFromSecretKey } from '@ton/crypto';
import { UIProvider } from '../../ui/UIProvider';
import { BlueprintTonClient } from '../NetworkProvider';

interface WalletInstance extends Contract {
    getSeqno(provider: ContractProvider): Promise<number>;

    sendTransfer(
        provider: ContractProvider,
        args: {
            seqno: number;
            secretKey: Buffer;
            messages: MessageRelaxed[];
            sendMode: SendMode;
            timeout?: number;
        },
    ): Promise<void>;
}

interface WalletClass {
    create(args: { workchain?: number; publicKey: Buffer; walletId?: any }): WalletInstance;
}

export type WalletVersion = 'v1r1' | 'v1r2' | 'v1r3' | 'v2r1' | 'v2r2' | 'v3r1' | 'v3r2' | 'v4' | 'v5r1';

export type WalletId = {
    networkGlobalId: number;
} | number | null | undefined;

const wallets: Record<WalletVersion, WalletClass> = {
    v1r1: WalletContractV1R1,
    v1r2: WalletContractV1R2,
    v1r3: WalletContractV1R3,
    v2r1: WalletContractV2R1,
    v2r2: WalletContractV2R2,
    v3r1: WalletContractV3R1,
    v3r2: WalletContractV3R2,
    v4: WalletContractV4,
    v5r1: WalletContractV5R1,
};

export class MnemonicProvider implements SendProvider {
    #wallet: OpenedContract<WalletInstance>;
    #secretKey: Buffer;
    #client: BlueprintTonClient;
    #ui: UIProvider;

    constructor(params: {
        version: WalletVersion;
        workchain?: number;
        secretKey: Buffer;
        client: BlueprintTonClient;
        ui: UIProvider;
        walletId?: WalletId;
    }) {
        if (!(params.version in wallets)) {
            throw new Error(`Unknown wallet version ${params.version}`);
        }

        const kp = keyPairFromSecretKey(params.secretKey);
        this.#client = params.client;
        this.#wallet = openContract<WalletInstance>(
            wallets[params.version].create({
                workchain: params.workchain ?? 0,
                publicKey: kp.publicKey,
                walletId: params.walletId,
            }),
            (params) =>
                this.#client.provider(
                    params.address,
                    params.init && {
                        ...params.init,
                        data: params.init.data ?? undefined,
                        code: params.init.code ?? undefined,
                    },
                ),
        );
        this.#secretKey = kp.secretKey;
        this.#ui = params.ui;
    }

    async connect() {
        this.#ui.write(`Connected to wallet at address: ${this.address()}\n`);
    }

    async sendTransaction(
        address: Address,
        amount: bigint,
        payload?: Cell | undefined,
        stateInit?: StateInit | undefined,
    ) {
        await this.#wallet.sendTransfer({
            seqno: await this.#wallet.getSeqno(),
            secretKey: this.#secretKey,
            messages: [
                {
                    init: stateInit,
                    body: payload ?? new Cell(),
                    info: {
                        type: 'internal',
                        ihrDisabled: true,
                        ihrFee: 0n,
                        bounce: true,
                        bounced: false,
                        dest: address,
                        value: { coins: amount },
                        forwardFee: 0n,
                        createdAt: 0,
                        createdLt: 0n,
                    },
                },
            ],
            sendMode: SendMode.PAY_GAS_SEPARATELY,
        });

        this.#ui.write('Sent transaction');
    }

    address() {
        return this.#wallet.address;
    }
}
