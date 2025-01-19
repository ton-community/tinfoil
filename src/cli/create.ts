import { Args, Runner } from './Runner';
import { lstat, mkdir, open, readdir, readFile } from 'fs/promises';
import path from 'path';
import { executeTemplate, TEMPLATES_DIR } from '../template';
import { selectOption } from '../utils';
import arg from 'arg';
import { UIProvider } from '../ui/UIProvider';
import { buildOne } from '../build';
import { getConfig } from '../config/utils';
import { helpArgs, helpMessages, templateTypes } from './constants';

function toSnakeCase(v: string): string {
    const r = v.replace(/[A-Z]/g, (sub) => '_' + sub.toLowerCase());
    return r[0] === '_' ? r.substring(1) : r;
}

async function createFile(templatePath: string, realPath: string, replaces: { [k: string]: string }) {
    const template = (await readFile(templatePath)).toString('utf-8');
    const lines = template.split('\n');
    const fileName = executeTemplate(lines.shift()!, replaces);
    const contents = executeTemplate(lines.join('\n'), replaces);

    const p = path.join(realPath, fileName);
    const file = await open(p, 'a+');
    if ((await file.stat()).size > 0) {
        console.warn(`${p} already exists, not changing.`);
        await file.close();
        return;
    }

    await file.writeFile(contents);
    await file.close();
}

async function createFiles(templatePath: string, realPath: string, replaces: { [k: string]: string }) {
    const contents = await readdir(templatePath);

    for (const file of contents) {
        const tp = path.join(templatePath, file);
        const rp = path.join(realPath, file);
        if ((await lstat(tp)).isDirectory()) {
            await createFiles(tp, rp, replaces);
        } else {
            await mkdir(path.dirname(rp), {
                recursive: true,
            });
            await createFile(tp, realPath, replaces);
        }
    }
}

export const create: Runner = async (args: Args, ui: UIProvider) => {
    const localArgs = arg({
        '--type': String,
        ...helpArgs,
    });
    if (localArgs['--help']) {
        ui.write(helpMessages['create']);
        return;
    }

    const name =
        localArgs._.length > 1 && localArgs._[1].trim().length > 0
            ? localArgs._[1].trim()
            : await ui.input('Contract name (PascalCase)');

    if (name.length === 0) throw new Error(`Cannot create a contract with an empty name`);

    if (name.toLowerCase() === 'contract' || !/^[A-Z][a-zA-Z0-9]*$/.test(name))
        throw new Error(`Cannot create a contract with the name '${name}'`);

    const which = (
        await selectOption(templateTypes, {
            ui,
            msg: 'What type of contract do you want to create?',
            hint: localArgs['--type'],
        })
    ).value;

    const [lang, template] = which.split('-');

    const snakeName = toSnakeCase(name);

    const replaces = {
        name,
        loweredName: name.substring(0, 1).toLowerCase() + name.substring(1),
        snakeName,
        contractPath: 'contracts/' + snakeName + '.' + (lang === 'func' ? 'fc' : lang === 'tolk' ? 'tolk' : 'tact'),
    };

    const config = await getConfig();

    const commonPath = config?.separateCompilables ? 'common' : 'not-separated-common';

    await createFiles(path.join(TEMPLATES_DIR, lang, commonPath), process.cwd(), replaces);
    await createFiles(path.join(TEMPLATES_DIR, lang, template), process.cwd(), replaces);

    if (lang === 'tact') {
        await buildOne(name, ui);
    }
};
