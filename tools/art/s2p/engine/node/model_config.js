// Shared JSON policy for every model client. Credentials never appear in publicConfig().
const fs=require('node:fs');
const path=require('node:path');
const ROOT=path.resolve(__dirname,'..');
const {controllerDefaults,gatewayCredential,protocol}=require('./codex_config.js');
const merge=(a,b)=>{const out={...a};for(const [k,v] of Object.entries(b||{}))out[k]=v&&typeof v==='object'&&!Array.isArray(v)?merge(a?.[k]||{},v):v;return out;};
const read=file=>JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
function loadEnv(file){if(!fs.existsSync(file))return;for(const line of fs.readFileSync(file,'utf8').split(/\r?\n/)){const m=line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);if(m&&!(m[1] in process.env))process.env[m[1]]=m[2].replace(/^(['"])(.*)\1$/,'$2');}}
let cached;
function loadConfig(){
  const explicit=process.env.LAYERFORGE_CONFIG;
  const local=path.resolve(explicit||path.join(ROOT,'config.json'));
  for(const file of [path.join(path.dirname(local),'.env.local'),path.join(process.cwd(),'.env.local'),path.join(ROOT,'.env.local')])loadEnv(file);
  if(explicit&&!fs.existsSync(local))throw Error('Model configuration file does not exist: '+local);
  const stamp=[local,fs.existsSync(local)?fs.statSync(local).mtimeMs:0,fs.statSync(path.join(ROOT,'config.example.json')).mtimeMs].join(':');
  if(cached?.stamp===stamp)return cached.config;
  const overrides=fs.existsSync(local)?read(local):{};
  let defaults=read(path.join(ROOT,'config.example.json'));
  const controller=overrides.llm?.routes?.controller;
  const needsCodex=controller?.source==='codex'||Object.values(overrides.llm?.routes||{}).some(route=>route.gateway_source==='codex'||route.credential_source==='codex');
  const imported=needsCodex?controllerDefaults({file:process.env.S2P_CODEX_CONFIG||(controller?.codex_config?path.resolve(path.dirname(local),controller.codex_config):undefined),profile:process.env.S2P_CODEX_PROFILE||controller?.codex_profile}):null;
  if(controller?.source==='codex') {
    imported.api_key='${LAYERFORGE_CONTROLLER_API_KEY}';
    imported.env={api_key:['LAYERFORGE_CONTROLLER_API_KEY','LAYERFORGE_API_KEY']};
    defaults=merge(defaults,{llm:{routes:{controller:imported}}});
  }
  const config=merge(defaults,overrides);
  if(imported)config.llm.codex_gateway={base_url:imported.credential_binding?.base_url||imported.base_url,config_source:imported.config_source,credential_env:imported.credential_env};
  if(!config.llm?.routes)throw Error('Model configuration requires llm.routes');
  cached={stamp,config};return config;
}
const aliases={'openai-image':'image','foreground-image':'foreground','background-repair':'background','background-image':'background',gemini:'gemini_image',ark:'ark_image'};
const expand=v=>typeof v==='string'?v.replace(/\$\{(\w+)\}/g,(_,k)=>process.env[k]||''):v;
function getRoute(name='image'){
  name=aliases[name]||name;const config=loadConfig().llm;
  function resolve(role,seen=[]){
    if(seen.includes(role))throw Error('Model route inheritance cycle: '+[...seen,role].join(' -> '));
    const own=config.routes[role];if(!own)throw Error('Unknown model route: '+role);
    const route=merge(own.inherits?resolve(own.inherits,[...seen,role]):{quality:config.quality,timeout_ms:config.timeout_ms,max_retries:config.max_retries},own);
    if(route.gateway_source==='codex') {
      route.base_url=config.codex_gateway.base_url;
      route.credential_binding=config.codex_gateway;
    }
    for(const key of ['base_url','api_key','model','quality','provider','timeout_ms','max_retries','wire_api','reasoning_effort']){
      route[key]=expand(route[key]);
      for(const variable of own.env?.[key]||[]){if(process.env[variable]){route[key]=process.env[variable];break;}}
    }
    if(role==='controller') {
      for(const [field,variable] of Object.entries({model:'S2P_CONTROLLER_MODEL',base_url:'S2P_CONTROLLER_BASE_URL',wire_api:'S2P_CONTROLLER_WIRE_API'}))if(process.env[variable])route[field]=process.env[variable];
      if(!process.env.S2P_CONTROLLER_WIRE_API&&process.env.LAYERFORGE_CONTROLLER_WIRE_API)route.wire_api=process.env.LAYERFORGE_CONTROLLER_WIRE_API;
      if(process.env.LAYERFORGE_CONTROLLER_REASONING_EFFORT)route.reasoning_effort=process.env.LAYERFORGE_CONTROLLER_REASONING_EFFORT;
    }
    return route;
  }
  const route=resolve(name);route.role=name;
  route.wire_api=protocol(route.wire_api||'chat_completions');
  if(route.reasoning_effort&&!['none','minimal','low','medium','high','xhigh','max','ultra'].includes(route.reasoning_effort))throw Error('Invalid reasoning_effort for model route: '+name);
  if(!route.model||!route.base_url)throw Error('Model route requires model and base_url: '+name);
  route.timeout_ms=Number(route.timeout_ms);route.max_retries=Number(route.max_retries);
  if(!Number.isFinite(route.timeout_ms)||route.timeout_ms<=0||!Number.isInteger(route.max_retries)||route.max_retries<0)throw Error('Invalid timeout_ms or max_retries for model route: '+name);
  if(!route.api_key&&route.credential_source==='codex') {
    const credential=gatewayCredential(route.credential_binding||config.codex_gateway,route.base_url);
    route.api_key=credential.key;
    route.credential_origin=credential.origin;
    route.credential_reuse_status=credential.reason||'available';
  } else {
    route.credential_origin=route.api_key?'project_or_environment':'missing';
  }
  return route;
}
const modelFor=role=>getRoute(role).model;
const qualityFor=(role='image')=>getRoute(role).quality;
function normalizeBase(base){base=String(base).replace(/\/+$/,'');if(/\/v1$/i.test(base))return base;return base+(/\.openai\.azure\.com$/i.test(base)?'/openai/v1':'/v1');}
function publicConfig(){const llm=loadConfig().llm;return {routes:Object.fromEntries(Object.keys(llm.routes).map(role=>{const r=getRoute(role);return [role,Object.fromEntries(['model','base_url','provider','quality','timeout_ms','max_retries','wire_api','reasoning_effort','source','config_source','credential_env','credential_source','credential_binding','gateway_source'].map(k=>[k,r[k]]))];})),controller_models:[...new Set([modelFor('controller'),...(llm.controller_models||[])])]};}
module.exports={loadConfig,loadEnv,getRoute,modelFor,qualityFor,normalizeBase,publicConfig};
if(require.main===module){try{console.log(JSON.stringify(publicConfig()));}catch(error){console.error(error.message);process.exitCode=1;}}
