import {readFile,readdir} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=dirname(dirname(fileURLToPath(import.meta.url)));
const problems=[];let checked=0;
const forbidden=/^(?:extension-trust\.json|writer-config\.json|writer-settings-state\.json|deepseek-api-key|review-feedback\.json|auth\.json|cookies\.json|\.env(?:\..*)?)$/;
async function walk(dir){for(const entry of await readdir(dir,{withFileTypes:true})){
 if(['node_modules','.git','dist'].includes(entry.name))continue;
 const path=join(dir,entry.name);if(entry.isSymbolicLink()){problems.push('symlink: '+entry.name);continue;}
 if(entry.isDirectory()){if(['backups','evidence','coverage'].includes(entry.name))problems.push('private output: '+entry.name);else await walk(path);continue;}
 checked++;if(forbidden.test(entry.name))problems.push('local configuration: '+entry.name);
 if(!entry.name.endsWith('.png')){const text=await readFile(path,'utf8');if(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text))problems.push('private key marker: '+entry.name);}
}}
await walk(root);
const data=JSON.parse(await readFile(join(root,'review-data.json'),'utf8'));
if(data.version!==1||!Array.isArray(data.items)||data.items.length)problems.push('review data must be empty in a public source release');
const manifest=JSON.parse(await readFile(join(root,'extension/manifest.json'),'utf8'));
const pkg=JSON.parse(await readFile(join(root,'package.json'),'utf8'));
if(manifest.version!==pkg.version||pkg.license!=='MIT')problems.push('release metadata mismatch');
if(problems.length){console.error(problems.join('\n'));process.exitCode=1;}else console.log(JSON.stringify({checkedFiles:checked,reviewItems:0,version:pkg.version,license:pkg.license,localCredentialsBundled:false}));
