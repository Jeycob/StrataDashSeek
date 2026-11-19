'use strict';
// Source-only fixture: production client.js is generated exclusively by the release owner.
const fs=require('node:fs'),path=require('node:path');
function createSourceFixture(directory,{appendSource=''}={}){
 const root=path.resolve(__dirname,'../..'),target=path.join(directory,'workbench-source');fs.mkdirSync(target);
 for(const file of ['index.mjs','package.json'])fs.copyFileSync(path.join(__dirname,file),path.join(target,file));
 const browser=['shared/i18n.cjs','shared/ui-copy.cjs','shared/settings-health.cjs','mobile/apps.js','workspace/client.js'].map(file=>'// '+file+'\n'+fs.readFileSync(path.join(root,file),'utf8')).join('\n');
 const css=JSON.stringify(fs.readFileSync(path.join(__dirname,'theme.css'),'utf8'));
 // Optional bridge exists only in a temporary synthetic fixture, never product source.
 const source=require('./factory-source.cjs')()+'\n'+appendSource;
 const content=`(()=>{window.HARNESS_NATIVE_WORKBENCH=true;window.HARNESS_NATIVE_THEME_CSS=${css};\n${browser}\n})();\nwindow.__ModuleLoader__.load({id:'@stratadashseek/native-workbench',factory:require=>{const React=require('react');\n${source}\nreturn {inject,apply};}});\n`;
 fs.writeFileSync(path.join(target,'client.js'),content);return path.join(target,'index.mjs');
}
module.exports={createSourceFixture};
