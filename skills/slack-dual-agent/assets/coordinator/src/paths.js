import {fileURLToPath} from 'node:url';
import {dirname,resolve} from 'node:path';
export const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export const DATA=resolve(ROOT,'.local');
