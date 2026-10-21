import {readFile,writeFile,readdir,mkdir,rm,realpath} from 'node:fs/promises';
import {resolve,join,dirname,relative,extname,sep} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {deflateRawSync} from 'node:zlib';
import {createHash} from 'node:crypto';
const ROOT=dirname(dirname(fileURLToPath(import.meta.url)));
const SOURCE=join(ROOT,'extension');
const reserved = new Set(['license','安装说明.txt']);
const forbidden=/(?:^|\/)(?:node_modules|\.git|backups|evidence)(?:\/|$)|(?:^|\/)(?:extension-trust\.json|writer-config\.json|writer-settings-state\.json|deepseek-api-key|review-data\.json|review-feedback\.json|credentials(?:\.[^.]+)?|auth\.json|private\.(?:key|pem)|bridge\.mjs|service-manager\.mjs|writer-runner\.mjs|package(?:-lock)?\.json|\.env(?:\..*)?)$|\.(?:key|pem|p12|pfx)$/iu;
async function filesAt(directory,prefix=''){
 const files=[];
 for(const entry of await readdir(directory,{withFileTypes:true})){
  if(entry.name==='.DS_Store')continue;
  const path=(prefix?prefix+'/':'')+entry.name;
  if(reserved.has(path.toLowerCase()))throw new Error('Reserved generated package entry: '+path);
  if(entry.name.includes('\\')||/[\u0000-\u001f\u007f]/u.test(entry.name)||entry.isSymbolicLink()||forbidden.test(path))throw new Error('User package contains a non-distributable entry: '+path);
  if(entry.isDirectory())files.push(...await filesAt(join(directory,entry.name),path));
  else if(entry.isFile())files.push(path);
  else throw new Error('Unexpected package entry: '+path);
 }return files.sort();
}
const crcTable=Uint32Array.from({length:256},(_,value)=>{for(let bit=0;bit<8;bit++)value=value&1?0xedb88320^(value>>>1):value>>>1;return value>>>0;});
const crc32=bytes=>{let value=0xffffffff;for(const byte of bytes)value=crcTable[(value^byte)&255]^(value>>>8);return (value^0xffffffff)>>>0;};
function zip(entries){
 const records=[],central=[];let offset=0;
 for(const {name,bytes} of entries){
  const filename=Buffer.from(name),compressed=deflateRawSync(bytes),crc=crc32(bytes),header=Buffer.alloc(30),directory=Buffer.alloc(46);
  header.writeUInt32LE(0x04034b50,0);header.writeUInt16LE(20,4);header.writeUInt16LE(0x800,6);header.writeUInt16LE(8,8);header.writeUInt16LE(33,12);
  header.writeUInt32LE(crc,14);header.writeUInt32LE(compressed.length,18);header.writeUInt32LE(bytes.length,22);header.writeUInt16LE(filename.length,26);
  directory.writeUInt32LE(0x02014b50,0);directory.writeUInt16LE(20,4);directory.writeUInt16LE(20,6);directory.writeUInt16LE(0x800,8);directory.writeUInt16LE(8,10);directory.writeUInt16LE(33,14);
  directory.writeUInt32LE(crc,16);directory.writeUInt32LE(compressed.length,20);directory.writeUInt32LE(bytes.length,24);directory.writeUInt16LE(filename.length,28);directory.writeUInt32LE(offset,42);
  records.push(header,filename,compressed);central.push(directory,filename);offset+=header.length+filename.length+compressed.length;
 }
 const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
 return Buffer.concat([...records,directory,end]);
}
function checkedPath(name,existing,from='manifest.json'){
 if(typeof name!=='string'||!name||name.startsWith('/')||name.includes('\\')||/^[a-z]+:/iu.test(name))throw new Error('Invalid packaged module/asset: '+name);
 const path=relative('.',join(dirname(from),name.split(/[?#]/u,1)[0])).split(sep).join('/');
 if(path.startsWith('../')||!existing.has(path))throw new Error('Missing packaged module/asset: '+path);
 return path;
}
async function canonicalOutput(path) {
 try { return await realpath(path); }
 catch(error) { if(error.code !== 'ENOENT') throw error; const parent=dirname(path); if(parent===path)throw error;return join(await canonicalOutput(parent),relative(parent,path)); }
}
const assetPaths=value=>typeof value==='string'?[value]:Object.values(value||{});
export async function buildExtension({source=SOURCE,output=join(ROOT,'dist')}={}){
 source=await realpath(resolve(source));output=await canonicalOutput(resolve(output));
 const staging=join(output,'XCommentAssistant');
 if(output===source||output.startsWith(source+sep)||staging===source||source.startsWith(staging+sep))throw new Error('Build output must be outside extension source and must not overlap it.');
 const files=await filesAt(source),existing=new Set(files),entries=[];
 const manifest=JSON.parse(await readFile(join(source,'manifest.json'),'utf8'));
 if(manifest.manifest_version!==3||typeof manifest.version!=='string'||!/^(?:0|[1-9]\d{0,4})(?:\.(?:0|[1-9]\d{0,4})){0,3}$/u.test(manifest.version)||manifest.version.split('.').some(x=>Number(x)>65535)||manifest.version.split('.').every(x=>Number(x)===0))throw new Error('Invalid extension manifest version.');
 checkedPath(manifest.background?.service_worker,existing);checkedPath(manifest.action?.default_popup,existing);
 for(const asset of [...assetPaths(manifest.icons),...assetPaths(manifest.action?.default_icon)])checkedPath(asset,existing);
 for(const content of manifest.content_scripts||[])for(const file of [...(content.js||[]),...(content.css||[])])checkedPath(file,existing);
 for(const file of files){
  const bytes=await readFile(join(source,file));
  if(['.js','.mjs'].includes(extname(file))){
   const text=bytes.toString();
   if(/(?:from\s*|import\s*|import\s*\(\s*)['"]node:|\brequire\s*\(/u.test(text))throw new Error('Node-only module in user extension: '+file);
   for(const match of text.matchAll(/(?:from\s*|import\s*|import\s*\(\s*)['"]([^'"]+)['"]/gu))checkedPath(match[1],existing,file);
  }
  if(extname(file)==='.html'){
   for(const match of bytes.toString().matchAll(/<(script|link|img|source|video|audio|iframe|a)\b[^>]*>/giu)){
    const attribute=match[0].match(/(?:src|href)\s*=\s*['"]([^'"]+)['"]/iu);if(!attribute||attribute[1].startsWith('#'))continue;
    if(/^https?:/iu.test(attribute[1])&&match[1].toLowerCase()==='a')continue;
    checkedPath(attribute[1],existing,file);
   }
  }
  if(extname(file)==='.css')for(const match of bytes.toString().matchAll(/url\(\s*['"]?([^'"\s)]+)['"]?\s*\)/giu))if(!match[1].startsWith('#')&&!match[1].startsWith('data:'))checkedPath(match[1],existing,file);
  entries.push({name:'XCommentAssistant/'+file,bytes});
 }
 entries.push({name:'XCommentAssistant/LICENSE',bytes:await readFile(join(ROOT,'LICENSE'))});
 entries.push({name:'XCommentAssistant/安装说明.txt',bytes:Buffer.from('X 评论助手 '+manifest.version+'\n\n1. 解压整个 ZIP，保留文件夹。\n2. Chrome 打开 chrome://extensions，Edge 打开 edge://extensions。\n3. 开启开发者模式，点“加载已解压的扩展”，选择本文件所在的 XCommentAssistant 文件夹（里面有 manifest.json）。\n4. 点工具栏插件图标 → 模型设置 → 填 API Key、选模型、保存。\n5. 刷新 X，从原帖点回复，再点“生成四条回复”，挑选并编辑后自己发送。\n\n云 API 不需要 Node、终端、本机服务、扩展 ID 或配对码。\n调用本地 Agent 需要另外安装可选桥接，说明见插件内帮助或项目文档。\nAPI Key 仅保存在当前浏览器本机，不跨设备同步；不要分享浏览器用户资料。\n\nhttps://github.com/captainyufei/x-comment-assistant\n')});
 await mkdir(output,{recursive:true});
 await rm(staging,{recursive:true,force:true});await mkdir(staging);
 for(const entry of entries){const local=entry.name.slice('XCommentAssistant/'.length);await mkdir(dirname(join(staging,local)),{recursive:true});await writeFile(join(staging,local),entry.bytes);}
 const bytes=zip(entries),archive=join(output,'x-comment-assistant.zip'),digest=createHash('sha256').update(bytes).digest('hex');
 await writeFile(archive,bytes);await writeFile(join(output,'SHA256SUMS.txt'),digest+'  x-comment-assistant.zip\n');
 return {version:manifest.version,archive,folder:staging,files:entries.length,bytes:bytes.length,sha256:digest};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)console.log(JSON.stringify(await buildExtension()));
