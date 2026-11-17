import path from 'node:path';
import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {installRuntimeAdmission} from './runtime-admission-hooks.mjs';
export const name='root-runtime-admission';
export const inject=['agents','tools','connection'];
export async function apply(ctx){const root=await fs.realpath(path.dirname(path.dirname(fileURLToPath(import.meta.url))));installRuntimeAdmission(ctx,{expectedCommit:path.basename(root)});}
