import { Address, Cell, Contract, ContractProvider, Dictionary, toNano } from '@ton/core';
import { doCompile } from '../compile/compile';
import { UIProvider } from '../ui/UIProvider';
import { Args, Runner, RunnerContext } from './Runner';
import path from 'path';
import { argSpec, createNetworkProvider } from '../network/createNetworkProvider';
import { selectCompile } from './build';
import { sleep } from '../utils';
import arg from 'arg';
import { helpArgs, helpMessages } from './constants';

type FuncCompilerSettings = {
    compiler: 'func';
    compilerSettings: {
        funcVersion: string;
        commandLine: string;
    };
};

type TactCompilerSettings = {
    compiler: 'tact';
    compilerSettings: {
        tactVersion: string;
    };
};

type CompilerSettings = FuncCompilerSettings | TactCompilerSettings;

type SourceObject = {
    includeInCommand: boolean;
    isEntrypoint: boolean;
    isStdLib: boolean;
    hasIncludeDirectives: boolean;
    folder: string;
};

type SourcesObject = {
    knownContractHash: string; // base64
    knownContractAddress: string;
    senderAddress: string;
    sources: SourceObject[];
} & CompilerSettings;

const backends: Record<
    'mainnet' | 'testnet',
    {
        sourceRegistry: Address;
        backends: string[];
        id: string;
    }
> = {
    mainnet: {
        sourceRegistry: Address.parse('EQD-BJSVUJviud_Qv7Ymfd3qzXdrmV525e3YDzWQoHIAiInL'),
        backends: [
            'https://ton-source-prod-1.herokuapp.com',
            'https://ton-source-prod-2.herokuapp.com',
            'https://ton-source-prod-3.herokuapp.com',
        ],
        id: 'orbs.com',
    },
    testnet: {
        sourceRegistry: Address.parse('EQCsdKYwUaXkgJkz2l0ol6qT_WxeRbE_wBCwnEybmR0u5TO8'),
        backends: ['https://ton-source-prod-testnet-1.herokuapp.com'],
        id: 'orbs-testnet',
    },
};

function removeRandom<T>(els: T[]): T {
    return els.splice(Math.floor(Math.random() * els.length), 1)[0];
}

class VerifierRegistry implements Contract {
    constructor(readonly address: Address) {}

    async getVerifiers(provider: ContractProvider) {
        const res = await provider.get('get_verifiers', []);
        const item = res.stack.readCell();
        const c = item.beginParse();
        const d = c.loadDict(Dictionary.Keys.BigUint(256), {
            serialize: () => {
                throw undefined;
            },
            parse: (s) => s,
        });

        return Array.from(d.values()).map((v) => {
            const admin = v.loadAddress();
            const quorom = v.loadUint(8);
            const pubKeyEndpoints = v.loadDict(Dictionary.Keys.BigUint(256), Dictionary.Values.Uint(32));

            return {
                admin: admin,
                quorum: quorom,
                pubKeyEndpoints: new Map<bigint, number>(Array.from(pubKeyEndpoints).map(([k, v]) => [k, v])),
                name: v.loadRef().beginParse().loadStringTail(),
                url: v.loadRef().beginParse().loadStringTail(),
            };
        });
    }
}
class SourceRegistry implements Contract {
    constructor(readonly address: Address) {}
    async getVerifierRegistry(provider: ContractProvider) {
        const { stack } = await provider.get('get_verifier_registry_address', []);
        return stack.readAddress();
    }
}

async function lookupCodeHash(hash: Buffer, ui: UIProvider, retryCount: number = 5): Promise<string | undefined> {
    type QueryResponse = {
        data: {
            account_states: Array<{
                address: string;
                workchain: number;
            }>;
        };
    };

    let queryResponse: QueryResponse;
    let foundAddr: string | undefined;
    let done = false;
    const graphqlUrl = 'https://dton.io/graphql/';
    const query = `{
        account_states(page:0, page_size:1, account_state_state_init_code_hash: "${hash.toString('hex').toUpperCase()}")
        {
            address
            workchain
        }
    }`;

    do {
        try {
            ui.write('Checking if such a contract is already deployed...');
            const resp = await fetch(graphqlUrl, {
                method: 'POST',
                body: JSON.stringify({ query }),
                headers: { 'Content-Type': 'application/json' },
            });
            if (resp.ok) {
                queryResponse = await resp.json();
                const states = queryResponse.data.account_states;
                if (states.length > 0) {
                    const state = states[0];
                    foundAddr = Address.parseRaw(`${state.workchain}:${state.address}`).toString();
                } else {
                    ui.write('No such contract was found!');
                }
                done = true;
            } else {
                retryCount--;
            }
            // Meh
        } catch (e: any) {
            retryCount--;
            if (e.cause) {
                if (e.cause.code == 'ETIMEDOUT') {
                    ui.write('API timed out, waiting...');
                    await sleep(5000);
                }
            } else {
                ui.write(e);
            }
        }
    } while (!done && retryCount > 0);

    return foundAddr;
}

export const verify: Runner = async (args: Args, ui: UIProvider, context: RunnerContext) => {
    const localArgs = arg({ ...argSpec, ...helpArgs });
    if (localArgs['--help']) {
        ui.write(helpMessages['verify']);
        return;
    }

    const sel = await selectCompile(ui, localArgs);

    const networkProvider = await createNetworkProvider(ui, localArgs, context.config, false);

    const sender = networkProvider.sender();

    const senderAddress = sender.address;
    if (senderAddress === undefined) {
        throw new Error('Sender address needs to be known');
    }

    const network = networkProvider.network();
    if (network === 'custom') {
        throw new Error('Cannot use custom network');
    }

    const result = await doCompile(sel.name);
    const resHash = result.code.hash();

    ui.write(`Compiled code hash hex: ${resHash.toString('hex')}`);
    ui.write('We can look up the address with such code hash in the blockchain automatically');

    const passManually = await ui.prompt('Do you want to specify the address manually?');
    let addr: string;

    if (passManually) {
        addr = (await ui.inputAddress('Deployed contract address')).toString();
    } else {
        const alreadyDeployed = await lookupCodeHash(resHash, ui);
        if (alreadyDeployed) {
            ui.write(`Contract is already deployed at: ${alreadyDeployed}\nUsing that address.`);
            ui.write(`https://tonscan.org/address/${alreadyDeployed}`);
            addr = alreadyDeployed;
        } else {
            ui.write("Please enter the contract's address manually");
            addr = (await ui.inputAddress('Deployed contract address')).toString();
        }
    }

    let src: SourcesObject;
    const fd = new FormData();

    if (result.lang === 'func') {
        for (const f of result.snapshot) {
            fd.append(f.filename, new Blob([f.content]), path.basename(f.filename));
        }

        src = {
            compiler: 'func',
            compilerSettings: {
                funcVersion: result.version,
                commandLine: '-SPA ' + result.targets.join(' '),
            },
            knownContractAddress: addr,
            knownContractHash: result.code.hash().toString('base64'),
            sources: result.snapshot.map((s) => ({
                includeInCommand: result.targets.includes(s.filename),
                isEntrypoint: result.targets.includes(s.filename),
                isStdLib: false,
                hasIncludeDirectives: true,
                folder: path.dirname(s.filename),
            })),
            senderAddress: senderAddress.toString(),
        };
    } else if (result.lang === 'tact') {
        let pkg: { name: string; content: Buffer } | undefined = undefined;
        for (const [k, v] of result.fs) {
            if (k.endsWith('.pkg')) {
                pkg = {
                    name: k,
                    content: v,
                };
                break;
            }
        }
        if (pkg === undefined) {
            throw new Error('Could not find .pkg in compilation results');
        }

        fd.append(path.basename(pkg.name), new Blob([pkg.content]), path.basename(pkg.name));

        src = {
            compiler: 'tact',
            compilerSettings: {
                tactVersion: '',
            },
            knownContractAddress: addr,
            knownContractHash: result.code.hash().toString('base64'),
            sources: [
                {
                    includeInCommand: true,
                    isEntrypoint: false,
                    isStdLib: false,
                    hasIncludeDirectives: false,
                    folder: '',
                },
            ],
            senderAddress: senderAddress.toString(),
        };
    } else {
        // future proofing

        throw new Error('Unsupported language ' + (result as any).lang);
    }

    fd.append(
        'json',
        new Blob([JSON.stringify(src)], {
            type: 'application/json',
        }),
        'blob',
    );

    const backend = backends[network];

    const sourceRegistry = networkProvider.open(new SourceRegistry(backend.sourceRegistry));
    const verifierRegistry = networkProvider.open(new VerifierRegistry(await sourceRegistry.getVerifierRegistry()));

    const verifier = (await verifierRegistry.getVerifiers()).find((v) => v.name === backend.id);
    if (verifier === undefined) {
        throw new Error('Could not find verifier');
    }

    const remainingBackends = [...backend.backends];

    const sourceResponse = await fetch(removeRandom(remainingBackends) + '/source', {
        method: 'POST',
        body: fd,
    });

    if (sourceResponse.status !== 200) {
        throw new Error('Could not compile on backend:\n' + (await sourceResponse.json()));
    }

    const sourceResult = await sourceResponse.json();

    if (sourceResult.compileResult.result !== 'similar') {
        throw new Error(sourceResult.compileResult.error);
    }

    let msgCell = sourceResult.msgCell;
    let acquiredSigs = 1;

    while (acquiredSigs < verifier.quorum) {
        const curBackend = removeRandom(remainingBackends);
        ui.write(`Using backend: ${curBackend}`);
        const signResponse = await fetch(curBackend + '/sign', {
            method: 'POST',
            body: JSON.stringify({
                messageCell: msgCell,
            }),
            headers: { 'Content-Type': 'application/json' },
        });

        if (signResponse.status !== 200) {
            throw new Error('Could not sign on backend:\n' + (await signResponse.text()));
        }

        const signResult = await signResponse.json();

        msgCell = signResult.msgCell;
        acquiredSigs++;
    }

    const c = Cell.fromBoc(Buffer.from(msgCell.data))[0];

    await networkProvider.sender().send({
        to: verifierRegistry.address,
        value: toNano('0.5'),
        body: c,
    });

    ui.write(`Contract successfully verified at https://verifier.ton.org/${addr}`);
};
