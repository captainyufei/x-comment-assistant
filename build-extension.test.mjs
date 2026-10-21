import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,mkdir,cp,rm,symlink,stat,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {inflateRawSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {buildExtension} from './scripts/build-extension.mjs';
const ROOT=dirname(fileURLToPath(import.meta.url));
const crc32=bytes=>{let crc=0xffffffff;for(const byte of bytes){crc^=byte;for(let bit=0;bit<8;bit++)crc=crc&1?(crc>>>1)^0xedb88320:crc>>>1;}return (crc^0xffffffff)>>>0;};
// Independently parse ZIP records and inflate their bytes. Checking only a file
// extension or an archive magic prefix would miss corrupt user downloads.
function unzip(bytes){
  const end=bytes.length-22;assert.equal(bytes.readUInt32LE(end),0x06054b50);assert.equal(bytes.readUInt16LE(end+20),0);
  assert.equal(bytes.readUInt16LE(end+4),0);assert.equal(bytes.readUInt16LE(end+6),0);
  const count=bytes.readUInt16LE(end+10),centralSize=bytes.readUInt32LE(end+12),centralStart=bytes.readUInt32LE(end+16);
  assert.equal(bytes.readUInt16LE(end+8),count);assert.equal(centralStart+centralSize,end);
  const output=new Map();let at=centralStart;
  for(let index=0;index<count;index++){
    assert.equal(bytes.readUInt32LE(at),0x02014b50);assert.equal(bytes.readUInt16LE(at+8),0x800);assert.equal(bytes.readUInt16LE(at+10),8);
    const crc=bytes.readUInt32LE(at+16),compressedSize=bytes.readUInt32LE(at+20),size=bytes.readUInt32LE(at+24),nameSize=bytes.readUInt16LE(at+28),extraSize=bytes.readUInt16LE(at+30),commentSize=bytes.readUInt16LE(at+32),offset=bytes.readUInt32LE(at+42);
    const name=bytes.subarray(at+46,at+46+nameSize).toString('utf8');assert.equal(output.has(name),false,`duplicate ZIP entry ${name}`);
    assert.equal(bytes.readUInt32LE(offset),0x04034b50);assert.equal(bytes.readUInt16LE(offset+6),0x800);assert.equal(bytes.readUInt16LE(offset+8),8);
    assert.equal(bytes.readUInt32LE(offset+14),crc);assert.equal(bytes.readUInt32LE(offset+18),compressedSize);assert.equal(bytes.readUInt32LE(offset+22),size);
    const localNameSize=bytes.readUInt16LE(offset+26),localExtraSize=bytes.readUInt16LE(offset+28);assert.equal(localNameSize,nameSize);assert.equal(bytes.subarray(offset+30,offset+30+localNameSize).toString('utf8'),name);
    const start=offset+30+localNameSize+localExtraSize;assert.ok(start+compressedSize<=centralStart);
    const data=inflateRawSync(bytes.subarray(start,start+compressedSize));assert.equal(data.length,size);assert.equal(crc32(data),crc,`CRC32 mismatch for ${name}`);
    output.set(name,data);at+=46+nameSize+extraSize+commentSize;
  }
  assert.equal(at,end);return output;
}
async function fixture(t){const path=await realpath(await mkdtemp(join(tmpdir(),'x-comment-build-')));t.after(()=>rm(path,{recursive:true,force:true}));return path;}
async function sourceCopy(t){const path=await fixture(t),source=join(path,'source');await cp(join(ROOT,'extension'),source,{recursive:true});return {path,source,output:join(path,'output')};}
function assertPackagedPath(name,entries,from='manifest.json'){
  assert.equal(typeof name,'string');assert.ok(name&&!name.startsWith('/')&&!name.includes('\\'));assert.doesNotMatch(name,/^[a-z]+:/iu);
  const url=new URL(name,`https://package.invalid/${from}`);assert.equal(url.origin,'https://package.invalid');const key='XCommentAssistant'+url.pathname;assert.ok(entries.has(key),`${from} must resolve ${name} inside user ZIP`);
}

test('user ZIP independently inflates, validates every CRC and loads its root manifest with complete browser imports',async t=>{
  const path=await fixture(t),output=join(path,'dist');const result=await buildExtension({output});const zip=await readFile(result.archive),entries=unzip(zip),manifest=JSON.parse(entries.get('XCommentAssistant/manifest.json'));
  assert.equal(result.archive,join(output,'x-comment-assistant.zip'));assert.equal(result.folder,join(output,'XCommentAssistant'));assert.equal(result.version,manifest.version);assert.equal(manifest.version,JSON.parse(await readFile(join(ROOT,'extension/manifest.json'))).version);
  assert.equal(entries.size,result.files);assert.equal(zip.length,result.bytes);assert.equal(createHash('sha256').update(zip).digest('hex'),result.sha256);assert.equal(await readFile(join(output,'SHA256SUMS.txt'),'utf8'),`${result.sha256}  x-comment-assistant.zip\n`);
  assert.equal(manifest.manifest_version,3);assert.equal(manifest.background.type,'module');assert.ok(entries.has('XCommentAssistant/LICENSE'));assert.ok(entries.has('XCommentAssistant/安装说明.txt'));
  const install=entries.get('XCommentAssistant/安装说明.txt').toString();assert.ok(install.includes(manifest.version));assert.match(install,/加载已解压/);assert.match(install,/API Key/);assert.match(install,/云 API 不需要 Node/);
  for(const [name,bytes] of entries){
    assert.ok(name.startsWith('XCommentAssistant/')&&!name.startsWith('XCommentAssistant/extension/'));assert.equal(name.includes('..'),false);assert.equal(name.includes('\\'),false);
    assert.doesNotMatch(name,/(?:^|\/)(?:node_modules|\.git|dist|backups|evidence|bridge\.mjs|service-manager\.mjs|package(?:-lock)?\.json|writer-config\.json|deepseek-api-key|\.env)(?:\/|$)/u);
    assert.deepEqual(await readFile(join(output,name)),bytes,`extracted directory differs from ZIP for ${name}`);
    if(name.endsWith('.js')||name.endsWith('.mjs'))for(const match of bytes.toString().matchAll(/(?:from\s*|import\s*)['"]([^'"]+)['"]/gu))assertPackagedPath(match[1],entries,name.slice('XCommentAssistant/'.length));
  }
  for(const item of [manifest.background.service_worker,manifest.action.default_popup,...Object.values(manifest.icons),...Object.values(manifest.action.default_icon),...manifest.content_scripts.flatMap(x=>[...(x.js||[]),...(x.css||[])])])assertPackagedPath(item,entries);
  for(const [name,bytes] of entries)if(name.endsWith('.html'))for(const match of bytes.toString().matchAll(/(?:src|href)\s*=\s*['"]([^'"]+)['"]/giu))if(!/^(?:https?:|#)/iu.test(match[1]))assertPackagedPath(match[1],entries,name.slice('XCommentAssistant/'.length));
});

test('repeated builds in independent temporary directories produce byte-identical ZIP and SHA256',async t=>{
  const path=await fixture(t),first=await buildExtension({output:join(path,'one')}),second=await buildExtension({output:join(path,'two')});assert.equal(first.sha256,second.sha256);assert.deepEqual(await readFile(first.archive),await readFile(second.archive));assert.deepEqual([...unzip(await readFile(first.archive)).keys()],[...unzip(await readFile(second.archive)).keys()]);
});

test('build rejects a missing transitive JS module instead of shipping a popup that cannot load',async t=>{const h=await sourceCopy(t);await writeFile(join(h.source,'fixture.js'),"import './missing-module.js';\n");await assert.rejects(buildExtension(h),/Missing packaged module\/asset/);});
test('build rejects a missing popup HTML script or stylesheet before writing an archive',async t=>{for(const html of ['<script type="module" src="missing-popup.js"></script>','<link rel="stylesheet" href="missing-popup.css">']){const h=await sourceCopy(t);await writeFile(join(h.source,'popup.html'),html);await assert.rejects(buildExtension(h),/Missing packaged module\/asset/);}});
test('manifest action icons and content CSS resolve to real package assets',async t=>{for(const kind of ['icon','css']){const h=await sourceCopy(t),file=join(h.source,'manifest.json'),manifest=JSON.parse(await readFile(file));if(kind==='icon')manifest.action.default_icon={'128':'icons/missing-action.png'};else manifest.content_scripts[0].css=['missing-content.css'];await writeFile(file,JSON.stringify(manifest));await assert.rejects(buildExtension(h),/Missing packaged module\/asset/);}});
test('dynamic literal imports cannot escape the package or hide a missing module',async t=>{const h=await sourceCopy(t);await writeFile(join(h.source,'fixture.js'),"export const lazy=()=>import('../private-module.mjs');\n");await assert.rejects(buildExtension(h),/Missing packaged module\/asset/);});
test('Node-only imports are rejected instead of becoming browser runtime errors',async t=>{const h=await sourceCopy(t);await writeFile(join(h.source,'fixture.js'),"import {readFile} from 'node:fs/promises';\n");await assert.rejects(buildExtension(h),/Node-only module/);});

test('symlink files and folders are refused before packaging external or private data',async t=>{
  for(const directory of [false,true]){const h=await sourceCopy(t),target=join(h.path,directory?'private':'private.txt');if(directory){await mkdir(target);await writeFile(join(target,'secret.txt'),'fixture private data');}else await writeFile(target,'fixture private data');
    try{await symlink(target,join(h.source,directory?'linked-folder':'linked-file'),directory?'dir':'file');}catch(error){if(['EPERM','ENOTSUP'].includes(error.code)){t.diagnostic('Symlink fixture unsupported on this host');continue;}throw error;}
    await assert.rejects(buildExtension(h),/non-distributable entry/);
  }
});
test('known private files and backend-only filenames are refused before packaging',async t=>{
  for(const name of ['.env','.env.local','writer-config.json','writer-settings-state.json','extension-trust.json','deepseek-api-key','review-feedback.json','credentials.json','private.key','bridge.mjs']){
    const h=await sourceCopy(t);await writeFile(join(h.source,name),'fixture private data');await assert.rejects(buildExtension(h),/non-distributable entry/,name);
  }
});
test('reserved generated names cannot create duplicate ZIP entries',async t=>{const h=await sourceCopy(t);await writeFile(join(h.source,'LICENSE'),'not the project license');await assert.rejects(buildExtension(h),/reserved|duplicate/i);});
test('output cannot delete its source by reusing the staging directory',async t=>{const path=await fixture(t),source=join(path,'XCommentAssistant');await cp(join(ROOT,'extension'),source,{recursive:true});await assert.rejects(buildExtension({source,output:path}),/outside|overlap/);assert.ok((await stat(join(source,'manifest.json'))).isFile());});

test('CSS referenced assets and invalid Chrome version cannot produce an installable-looking ZIP',async t=>{const h=await sourceCopy(t);await writeFile(join(h.source,'popup.css'),'body{background:url("missing-background.png")}');await assert.rejects(buildExtension(h),/Missing packaged module\/asset/);for(const version of ['0.0.0','1.2.3.4.5','1.65536','01.2','latest']){const other=await sourceCopy(t),file=join(other.source,'manifest.json'),manifest=JSON.parse(await readFile(file));manifest.version=version;await writeFile(file,JSON.stringify(manifest));await assert.rejects(buildExtension(other),/manifest version/);}});
