import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const root=fileURLToPath(new URL('../src/',import.meta.url));
async function walk(dir){const out=[];for(const e of await readdir(dir,{withFileTypes:true})){if(e.name.startsWith('.'))continue;const p=path.join(dir,e.name);if(e.isDirectory())out.push(...await walk(p));else out.push(p);}return out;}
const app=JSON.parse(await readFile(path.join(root,'app.json'),'utf8'));
await stat(path.join(root,'AGENTS.md'));
if('workers' in app)throw new Error('obsolete_workers');
for(const route of app.pages){await stat(path.join(root,route+'.ink'));try{await stat(path.join(root,route+'.js'));throw new Error('mixed_page_structure');}catch(e){if(e.code!=='ENOENT')throw e;}}
let scripts=0;
for(const file of await walk(root)){
  const source=await readFile(file,'utf8');let js='';
  if(file.endsWith('.ink')){
    JSON.parse(source.match(/<script def>([\s\S]*?)<\/script>/)[1]);
    js=source.match(/<script setup>([\s\S]*?)<\/script>/)[1];
    if((source.match(/<page>/g)||[]).length!==1)throw new Error('invalid_page_root');
  }else if(file.endsWith('.js'))js=source;
  if(js){
    if(/\b(?:App|Page|Widget)\s*\(/.test(js))throw new Error('invalid_registration');
    execFileSync(process.execPath,['--check','--input-type=module'],{input:js});
    for(const m of js.matchAll(/from\s+['"](\.[^'"]+)['"]/g))await stat(path.resolve(path.dirname(file),m[1]));
    scripts++;
  }
}
console.log(`AIUI structure valid: ${app.pages.length} page, ${scripts} scripts, all local imports resolved`);
