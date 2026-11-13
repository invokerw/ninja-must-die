// Detached loopback report server. Serves only files within the selected result root.
const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const {pipeline}=require('node:stream');
const root=fs.realpathSync(path.resolve(process.argv[2]));
const port=Number(process.argv[3]);
const inside=file=>{const relative=path.relative(root,file);return relative!== '..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative);};
const types={'.html':'text/html; charset=utf-8','.json':'application/json; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.svg':'image/svg+xml','.psd':'application/octet-stream'};
http.createServer((request,response)=>{
  if(!['GET','HEAD'].includes(request.method)){response.writeHead(405);response.end();return;}
  let pathname;
  try{pathname=decodeURIComponent(new URL(request.url,'http://localhost').pathname);}catch{response.writeHead(400);response.end();return;}
  if(pathname==='/__psd_server__'){response.writeHead(200,{'Content-Type':'application/json'});response.end(JSON.stringify({root,pid:process.pid}));return;}
  try{
    const file=fs.realpathSync(path.resolve(root,'.'+pathname));
    if(!inside(file)||!fs.statSync(file).isFile()){response.writeHead(404);response.end();return;}
    response.writeHead(200,{'Content-Type':types[path.extname(file).toLowerCase()]||'application/octet-stream','Content-Length':fs.statSync(file).size,'Cache-Control':'no-cache'});
    if(request.method==='HEAD')response.end();else pipeline(fs.createReadStream(file),response,()=>{});
  }catch{response.writeHead(404);response.end();}
}).listen(port,'127.0.0.1',()=>console.log(JSON.stringify({root,port,pid:process.pid})));
