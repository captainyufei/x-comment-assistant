// Synthetic in-memory store for tests. It never accesses an OS keychain.
import {CredentialStoreError} from './credential-store.mjs';
export function fakeCredentialStore(){
  const records=new Map();let next=0;
  return {backend:'windows-dpapi',records,
    async seal(provider,key){
      const ciphertext=Buffer.from(`synthetic-${provider}-${String(++next).padStart(24,'0')}`).toString('base64');
      records.set(provider+':'+ciphertext,key);return {backend:'windows-dpapi',ciphertext};
    },
    async unseal(provider,envelope){
      const key=records.get(provider+':'+envelope.ciphertext);
      if(!key)throw new CredentialStoreError();return key;
    },
    async discard(provider,envelope){records.delete(provider+':'+envelope.ciphertext);},
  };
}
