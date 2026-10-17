import fs from 'node:fs';
import {combineMiddleware} from '../server/middleware.mjs';
fs.writeFileSync(new URL('../workbench.middleware.js', import.meta.url), combineMiddleware());
console.log('Built combined middleware; no provider rules or model holds bundled.');
