'use strict';
// Credential paths are excluded from code history/build archives, not from
// the application's own runtime access. No secret file contents are inspected.
const directories=new Set(['.secrets','secrets','root-secrets','.credentials','.ssh','.aws','.codex']);
const privateFile=/^(?:\.env(?:\.(?!example$|sample$|template$).*)?|\.npmrc|\.pypirc|\.netrc|\.credentials(?:\..*)?|id_rsa(?:\..*)?|id_ed25519(?:\..*)?|vault-machine\.json|credentials\.json|(?:session|cookie|jwt|signing)[-_.]secrets?(?:\.(?:json|txt|bin))?)$|\.(?:pem|key|pfx|p12)$/iu;
function isPrivateSourcePath(value){
 if(typeof value!=='string')return true;
 return value.split(/[\\/]/u).some(part=>directories.has(part.toLowerCase())||privateFile.test(part));
}
module.exports={isPrivateSourcePath};
