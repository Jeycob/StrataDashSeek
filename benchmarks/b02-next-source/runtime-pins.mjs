// Reviewed static publication pins; all runtime qualification remains fresh/NULL.
const sourceCommit="266196e9427db575609cbbe5c8c6fb7c814f27ff";
const sourceTree="5fff1481ba17964b182d4401ccfe9823101fdd40";
const sourceDigest="4b2b33ba792e4988da6b3984a93c00618c5afe6978d2664ad31d4d9e753977f6";
const previousSourceCommit="cb142c0a007b1bbfc4116bc2c030097d1f9e039b";
const policySha256="c1c5b9c4d75a74f5321a7f352f0cf95f3ddb5faf8837860f584232071c26edf6";
const previousProfileSha256="af475f8437ee098f74275e84aab90a1b1108d22db02e2bbb5cce00ac076dc076";
const expectedProfileSha256="fed94034b8159c3d845e4d1fdb20272735c4ceac1f98b3fadaf840703935c9f4";
const appsSha256="e39895ff2a153d0556651a79e2d0d27307078d815aad66c9e5765835cd87e4db";
const ownerHost="vast-harness.tail9a42c6.ts.net";
const operatorCode="/data/harness/root-secrets/operator-n08-sequence-fix-code-20261118";
const operatorCommonSha256="820894a95a296f604754a9796765b0a9c9a6fa5985f70fdf2cccfa9c3c6881cd";
const offlineReceipt="/data/harness/root-secrets/operator-n08-sequence-fix-20261118-once01/profile-pin-complete.json";

const modules=Object.freeze({
  "benchmarks/n06-evidence-storage/adapter.mjs": "3dc9dae4b47fd6e0846bf34dbf0fab102a1eebbf55781269dbfe67f779d2bb16",
  "benchmarks/n06-evidence-storage/lifecycle.mjs": "21d75d10d59bba22564a9d1758f2817bb345d438854346f9105404d1d170bea7",
  "benchmarks/n06-evidence-storage/finalization.mjs": "e6c25073472114777fcf9c32db0054b33fbae29ab9dfbc5df3c86157d62f443e",
  "benchmarks/n06-evidence-storage/stop-scope.mjs": "8768d4a17a384baf964fee8fbcab2122293c14caf6ba4de1ef22a15c288e0e72",
  "benchmarks/n06-evidence-storage/native-transport.mjs": "11375282950bf54dfdaaf7a148d602a20c52453653ddc2f4debbf5aafb5fe026",
  "benchmarks/n06-finalization/frozen/n06-root-finalizer-20261117/finalizer.mjs": "9100ec8f0dee5982c58463fe9c01c624ffe58c7d59e2d5d6c97f13406df63e80",
  "benchmarks/n06-finalization/frozen/n06-root-bindings-20261117/bindings.mjs": "17a49477afe215a730ef17c06f0a5b6851151f3bab8625d45658ec7752771d3a",
  "benchmarks/n06-finalization/frozen/n06-root-lifecycle-20261117-r2/native-transport.mjs": "11375282950bf54dfdaaf7a148d602a20c52453653ddc2f4debbf5aafb5fe026",
  "benchmarks/b02-next-source/runner.mjs": "fd5216406ac2cea2a6fde2391f093f12c7def4a761bc1f5a7b8954e439c7a6c7",
  "benchmarks/b02-next-source/spec.mjs": "39319ebc087131ee076c2de3d2783b18d4fcd03db1376272ef276ca0dab90f24",
  "benchmarks/b02-next-source/prior.mjs": "0096a0a2b2a8cac93687bf8e3fa2418e774d69518f90eb5604bdf6f7d15173e9",
  "benchmarks/b02-next-source/frozen-inputs.mjs": "a227b4bc6a2446cccc22da0916f8aca82294df02b71d680d8b709f6701276985",
  "benchmarks/b02-next-source/qa-ordering.mjs": "138cf3b08de9c5b4ff12c77524813d84926d7cb0a649c2e3899617faa4c17341",
  "benchmarks/b02-next-source/fixture.mjs": "e7111e3d6a22539daa63f16ada4478f209c2eab89f2ea760606dd17bf0cf982e",
  "benchmarks/b02-next-source/runtime-guard.mjs": "320a0e7d61192a27abebc91a98e22dfcafdf4109798e85135b6f32681bd4a773"
});
export function runtimePins(slot){return{sourceCommit,sourceTree,sourceDigest,previousSourceCommit,policySha256,previousProfileSha256,expectedProfileSha256,appsSha256,ownerHost,operatorCode,operatorCommonSha256,offlineReceipt,modules,
 first:slot.target,driverFolder:'benchmarks/b02-next-source/'+(slot.variant==='DS'?'ds-first':'homeai-second'),codeRoot:slot.codeRoot,checkpointDirectory:slot.checkpointDirectory,fixtureEvidence:slot.target.preparedFixtureEvidence,frozenRoot:slot.frozenRoot,qaRoot:slot.qaRoot,
 recordFile:'benchmarks/b02-next-source/'+(slot.variant==='DS'?'ds-first':'homeai-second')+'/primary.record.json'};}
