import { build } from 'esbuild';
import { build as viteBuild } from 'vite';
import { existsSync } from 'node:fs';
const entries = ['main', 'preload', 'worker'].map(name => `electron/${name}.ts`).filter(existsSync);
await build({ entryPoints: entries, outdir: 'dist-electron', outExtension: { '.js': '.cjs' }, bundle: true, platform: 'node', format: 'cjs', target: 'node24', packages: 'external', sourcemap: true });
await viteBuild();
