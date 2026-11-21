import {build} from 'esbuild';
import {copyFile} from 'node:fs/promises';

await build({entryPoints:['frontend/dashboard.js'],bundle:true,format:'iife',platform:'browser',target:'es2022',outfile:'frontend/dashboard.bundle.js',logLevel:'info'});
await build({entryPoints:['frontend/gta-live.js'],bundle:true,format:'iife',platform:'browser',target:'es2022',outfile:'frontend/gta-live.bundle.js',logLevel:'info'});
await build({entryPoints:['frontend/dashboard-theme.css'],bundle:true,outfile:'frontend/dashboard.styles.css',external:['/public/*'],logLevel:'info'});
await build({entryPoints:['src/main.js'],bundle:true,format:'iife',platform:'browser',target:'es2022',outfile:'public/threejs/game.bundle.js',logLevel:'info'});
await build({entryPoints:['src/rl/pursuit-lab-worker.js'],bundle:true,format:'iife',platform:'browser',target:'es2022',outfile:'public/threejs/pursuit-lab-worker.bundle.js',logLevel:'info'});
await build({entryPoints:['src/ui/styles.css'],bundle:true,outfile:'public/threejs/game.styles.css',logLevel:'info'});
await copyFile('node_modules/three/LICENSE','public/threejs/THREE-LICENSE.txt');
