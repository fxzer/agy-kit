'use strict';
const fs=require('fs');const path=require('path');const os=require('os');
const FILE=path.join(os.homedir(),'.gemini/agy-kit/settings.json');
const KEYS=new Set(['capsule','contextDetailed','quotaPool','history','inlineUndo','folderStatus','recentSection']);
function validate(value){
  if(!value||typeof value.modules!=='object'||Array.isArray(value.modules)||value.modules===null)throw new Error('设置格式无效');
  const modules={};for(const [key,enabled] of Object.entries(value.modules)){
    if(!KEYS.has(key)||typeof enabled!=='boolean')throw new Error('设置包含未知开关或非布尔值');modules[key]=enabled;
  }
  return {modules};
}
function read(file=FILE){try{return validate(JSON.parse(fs.readFileSync(file,'utf8')));}catch{return null;}}
function write(value,file=FILE){
  const clean=validate(value);fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
  const temporary=file+'.tmp';try{fs.writeFileSync(temporary,JSON.stringify(clean),{mode:0o600});fs.chmodSync(temporary,0o600);fs.renameSync(temporary,file);}finally{if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
  return clean;
}
module.exports={read,write};
