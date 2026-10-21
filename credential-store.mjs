import {spawn} from 'node:child_process';
import {randomUUID,randomBytes,createCipheriv,createDecipheriv} from 'node:crypto';
import {win32} from 'node:path';

const SERVICE='com.yufei.x-comment-assistant.api-keys';
const REFERENCE=/^(deepseek|openai|qwen|kimi|minimax|doubao|ollama|lmstudio)-[a-f0-9-]{36}$/u;
const validKey=value=>typeof value==='string'&&/^[\x21-\x7e]{12,4096}$/u.test(value);
export class CredentialStoreError extends Error{
  constructor(code='CREDENTIAL_STORE_UNAVAILABLE',message='系统密钥存储不可用，未保存新密钥；原配置已保留。'){
    super(message);this.code=code;this.status=503;
  }
}
const failure=()=>new CredentialStoreError();

// All child input/output is captured privately. Credentials never enter argv,
// a shell, environment variables, temporary files, or error messages.
export function runCredentialProcess(command,args,input,{spawnImpl=spawn,timeoutMs=15000}={}){
  return new Promise((resolve,reject)=>{
    let child,stdout=[],bytes=0,settled=false;
    const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(failure()):resolve(value);};
    let timer;
    try{
      child=spawnImpl(command,args,{stdio:['pipe','pipe','pipe'],windowsHide:true,shell:false});
      timer=setTimeout(()=>{child.kill();finish(true);},timeoutMs);timer.unref?.();
      child.on('error',()=>finish(true));
      child.stdout.on('data',chunk=>{bytes+=chunk.length;if(bytes>32768){child.kill();finish(true);}else stdout.push(chunk);});
      // Never expose raw diagnostics: some platform tools may echo input.
      child.stderr.on('data',()=>{});
      child.on('close',code=>finish(code!==0,Buffer.concat(stdout).toString('utf8')));
      child.stdin.on('error',()=>finish(true));
      child.stdin.end(input);
    }catch{finish(true);}
  });
}

// The static PowerShell program reads secret/ciphertext ONLY from stdin.
// DPAPI CurrentUser avoids storing a separate encryption key in the app.
export const DPAPI_PROGRAM=`$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Security
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser
  $entropy = [System.Text.Encoding]::UTF8.GetBytes('XCommentAssistant/api-key/' + $request.provider)
  $bytes = [Convert]::FromBase64String($request.value)
  if ($request.operation -eq 'protect') {
    $result = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $entropy, $scope)
  } elseif ($request.operation -eq 'unprotect') {
    $result = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $entropy, $scope)
  } else { exit 2 }
  [Console]::Out.Write([Convert]::ToBase64String($result))
} catch { exit 1 }
`;

export function validateCredentialEnvelope(provider,input){
  if(!input||typeof input!=='object'||Array.isArray(input))throw failure();
  if(input.backend==='macos-keychain'&&Object.keys(input).every(key=>['backend','reference','ciphertext','iv','tag'].includes(key))&&
    typeof input.reference==='string'&&REFERENCE.test(input.reference)&&input.reference.startsWith(provider+'-')&&
    typeof input.ciphertext==='string'&&/^[A-Za-z0-9+/]+={0,2}$/u.test(input.ciphertext)&&input.ciphertext.length<=6000&&
    typeof input.iv==='string'&&Buffer.from(input.iv,'base64').length===12&&
    typeof input.tag==='string'&&Buffer.from(input.tag,'base64').length===16)
    return {backend:input.backend,reference:input.reference,ciphertext:input.ciphertext,iv:input.iv,tag:input.tag};
  if(input.backend==='windows-dpapi'&&Object.keys(input).every(key=>['backend','ciphertext'].includes(key))&&
    typeof input.ciphertext==='string'&&input.ciphertext.length<=16384&&input.ciphertext.length>=32&&
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(input.ciphertext))
    return {backend:input.backend,ciphertext:input.ciphertext};
  throw failure();
}

export function createCredentialStore({platform=process.platform,env=process.env,runProcess=runCredentialProcess}={}){
  const backend=platform==='darwin'?'macos-keychain':platform==='win32'?'windows-dpapi':'unsupported';
  const assertSupported=()=>{if(backend==='unsupported')throw new CredentialStoreError('CREDENTIAL_STORE_UNSUPPORTED','当前系统尚未接入安全密钥存储，新密钥未保存。');};
  const windowsCommand=win32.join(env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  const dpapi=async(operation,provider,value)=>{
    const output=(await runProcess(windowsCommand,['-NoLogo','-NoProfile','-NonInteractive','-Command',DPAPI_PROGRAM],
      JSON.stringify({operation,provider,value}))).trim();
    if(!output||!/^[A-Za-z0-9+/]+={0,2}$/u.test(output))throw failure();
    return output;
  };
  const api={backend,
    async seal(provider,key){
      assertSupported();if(!validKey(key)||!REFERENCE.test(provider+'-00000000-0000-0000-0000-000000000000'))throw failure();
      if(backend==='windows-dpapi'){
        const envelope=validateCredentialEnvelope(provider,{backend,ciphertext:await dpapi('protect',provider,Buffer.from(key).toString('base64'))});
        if(await api.unseal(provider,envelope)!==key)throw failure();
        return envelope;
      }
      const reference=provider+'-'+randomUUID(),wrappingKey=randomBytes(32),iv=randomBytes(12);
      const cipher=createCipheriv('aes-256-gcm',wrappingKey,iv);cipher.setAAD(Buffer.from(provider));
      const ciphertext=Buffer.concat([cipher.update(key,'utf8'),cipher.final()]).toString('base64');
      const envelope={backend,reference,ciphertext,iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64')};
      try{
        // Tokens here are constrained ASCII/base64; the interactive parser never
        // receives quotes, backslashes, whitespace, or injected commands.
        // security's interactive lines are limited to 4096 bytes. Store a
        // random AES wrapping key, so even long provider credentials fit safely.
        await runProcess('/usr/bin/security',['-q','-i'],`add-generic-password -s ${SERVICE} -a ${reference} -w ${wrappingKey.toString('base64')}\n`);
        // security interactive status is not a reliable per-command receipt.
        // Verify this newly unique record before committing its reference.
        if(await api.unseal(provider,envelope)!==key)throw failure();
        return envelope;
      }catch{await api.discard(provider,envelope).catch(()=>{});throw failure();}
      finally{wrappingKey.fill(0);}
    },
    async unseal(provider,input){
      assertSupported();const envelope=validateCredentialEnvelope(provider,input);
      if(envelope.backend!==backend)throw new CredentialStoreError('CREDENTIAL_STORE_PLATFORM_MISMATCH','密钥由另一操作系统加密，请在此电脑重新填写 API Key。');
      let key;
      if(backend==='windows-dpapi')key=Buffer.from(await dpapi('unprotect',provider,envelope.ciphertext),'base64').toString('utf8');
      else{
        const encoded=(await runProcess('/usr/bin/security',['find-generic-password','-s',SERVICE,'-a',envelope.reference,'-w'],'')).trim();
        const wrappingKey=Buffer.from(encoded,'base64');
        try{
          if(wrappingKey.length!==32)throw failure();
          const decipher=createDecipheriv('aes-256-gcm',wrappingKey,Buffer.from(envelope.iv,'base64'));
          decipher.setAAD(Buffer.from(provider));decipher.setAuthTag(Buffer.from(envelope.tag,'base64'));
          key=Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext,'base64')),decipher.final()]).toString('utf8');
        }catch{throw failure();}finally{wrappingKey.fill(0);}
      }
      if(!validKey(key))throw new CredentialStoreError('CREDENTIAL_STORE_READ_FAILED','系统中已保存的密钥暂时无法读取，请解锁系统密钥存储后重试。');
      return key;
    },
    async discard(provider,input){
      const envelope=validateCredentialEnvelope(provider,input);
      if(envelope.backend==='macos-keychain'&&backend==='macos-keychain')
        await runProcess('/usr/bin/security',['delete-generic-password','-s',SERVICE,'-a',envelope.reference],'');
    },
  };
  return api;
}
