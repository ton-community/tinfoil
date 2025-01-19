import { Args, Runner } from './Runner';
import { UIProvider } from '../ui/UIProvider';
import { readFile, writeFile } from 'fs/promises';
import { exec } from 'node:child_process';
import path from 'path';
import arg from 'arg';
import { helpArgs, helpMessages } from './constants';

const getVersions = (pkg: string, ui: UIProvider): Promise<string[]> => {
    return new Promise((resolve, reject) => {
        exec(`npm view ${pkg} versions --json`, (error, stdout, stderr) => {
            if (stderr) {
                ui.write(stderr);
            }
            if (stdout) {
                if (error === null) {
                    try {
                        const resJson = JSON.parse(stdout);
                        if (Array.isArray(resJson)) {
                            resolve(resJson);
                        } else {
                            reject(new TypeError('Expect json array on stdout, but got:\n' + stdout));
                        }
                    } catch (e) {
                        reject(e);
                    }
                    return;
                } else {
                    ui.write(stdout);
                }
            }
            if (error) {
                ui.write('Failed to get func-js-bin package versions!');
                reject(error);
            }
        });
    });
};

const install = (cmd: string, ui: UIProvider): Promise<void> => {
    return new Promise((resolve, reject) => {
        exec(cmd, (error, stdout, stderr) => {
            if (stderr) {
                ui.write(stderr);
            }
            if (stdout) {
                ui.write(stdout);
            }
            if (error) {
                reject(error);
                return;
            }
            resolve();
        });
    });
};

export const set: Runner = async (args: Args, ui: UIProvider) => {
    const localArgs = arg(helpArgs);
    if (localArgs['--help']) {
        ui.write(helpMessages['set']);
        return;
    }

    if (args._.length < 2) {
        throw new Error('Please pass a key');
    }

    switch (args._[1]) {
        case 'func': {
            const pkg = '@ton-community/func-js-bin';

            const funcVersions = await getVersions(pkg, ui);

            let version = args._.length > 2 ? args._[2] : '';
            if (!funcVersions.includes(version)) {
                version = await ui.choose('Choose FunC version', funcVersions, (s) => s);
            }

            const packagePath = path.join(process.cwd(), 'package.json');
            const packageContents = (await readFile(packagePath)).toString('utf-8');
            const parsedPackage = JSON.parse(packageContents);

            const packageManager: 'npm' | 'yarn' | 'pnpm' | 'other' = await ui.choose(
                'Choose your package manager',
                ['npm', 'yarn', 'pnpm', 'other'],
                (s) => s,
            );

            if (packageManager === 'other') {
                ui.write(
                    `Please find out how to override @ton-community/func-js-bin version to ${version} using your package manager, do that, and then install the packages`,
                );
                return;
            }

            const overrideKey = packageManager === 'yarn' ? 'resolutions' : 'overrides';

            parsedPackage[overrideKey] = {
                ...parsedPackage[overrideKey],
                [pkg]: version,
            };

            ui.write('Updating package.json...');

            await writeFile(packagePath, JSON.stringify(parsedPackage, null, 4));

            const installCmd = packageManager === 'yarn' ? 'yarn' : `${packageManager} i`;

            try {
                ui.write('Installing dependencies...');
                await install(installCmd, ui);
            } catch (e) {
                ui.write('Failed to install dependencies, rolling back package.json');
                await writeFile(packagePath, packageContents);
                throw e;
            }

            break;
        }
        default: {
            throw new Error('Unknown key: ' + args._[1]);
        }
    }
};
