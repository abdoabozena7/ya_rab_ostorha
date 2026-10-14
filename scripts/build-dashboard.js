import {build} from 'esbuild';

await build({entryPoints:['frontend/dashboard.js'],bundle:true,format:'iife',platform:'browser',target:'es2022',outfile:'frontend/dashboard.bundle.js',logLevel:'info'});
await build({entryPoints:['frontend/dashboard-theme.css'],bundle:true,outfile:'frontend/dashboard.styles.css',external:['/public/*'],logLevel:'info'});
