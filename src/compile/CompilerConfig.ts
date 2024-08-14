import { SourceResolver, SourcesMap, SourcesArray } from '@ton-community/func-js';
import { Cell } from '@ton/core';
import { ConfigProject } from '@tact-lang/compiler';

export type HookParams = {
    userData?: any;
};

export type CommonCompilerConfig = {
    preCompileHook?: (params: HookParams) => Promise<void>;
    postCompileHook?: (code: Cell, params: HookParams) => Promise<void>;
};

export type TactCompilerConfig = {
    lang: 'tact';
    target: string;
    options?: ConfigProject['options'];
};

export type FuncCompilerConfig = {
    lang?: 'func';
    optLevel?: number;
    debugInfo?: boolean;
} & (
    | {
          targets: string[];
          sources?: SourceResolver | SourcesMap;
      }
    | {
          targets?: string[];
          sources: SourcesArray;
      }
);

export type CompilerConfig = (TactCompilerConfig | FuncCompilerConfig) & CommonCompilerConfig;
