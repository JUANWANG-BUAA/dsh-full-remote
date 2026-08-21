/**
 * Head IIFE injected by tapIndex into the official web index HTML.
 * It runs on every page that loads that index, including local
 * `127.0.0.1` — tapIndex is not an authentication gate. The proxy
 * authenticates separately at its own listen port.
 *
 * Official settings / models / locale bind during their own apply,
 * which is earlier than any third-party client plugin. Wrapping
 * `settingsScope.bind` later cannot rewrite scopes that already chose
 * `persistence: 'memory'`. This IIFE wraps `__ModuleLoader__` so the
 * official connection plugin's `apply()` is followed by a pin of
 * `connection.isLoopback` on the handle (`ctx.get('connection', false)`).
 * Harness 0.1.0-rc.8 and later install a queue facade whose `create()` then
 * assigns `target.load = register` on the same object; wrapping `load`
 * once as a data property is overwritten. Trap `load` with an accessor
 * and re-trap after `create()` so later connection registrations still
 * wrap. It must not assign `ctx.provide` or other Cordis mixin accessors:
 * Context is a Proxy and those writes replace the shared ReflectService
 * method table (GitHub issue #9).
 *
 * Kept as an ES5 string so tests can eval it and the HTML injector can
 * splice it verbatim. Do not put `</script>` in this source.
 */
export const CONNECTION_CLIENT_ID = '@deepseek-ai/dsh-client-connection'

export const PAGE_BOOTSTRAP_SOURCE = '(function(){'
  + 'var c=globalThis.crypto;'
  + 'if(c&&typeof c.randomUUID!=="function"&&typeof c.getRandomValues==="function"){'
  + 'function u(){var b=c.getRandomValues(new Uint8Array(16));'
  + 'b[6]=(b[6]&15)|64;b[8]=(b[8]&63)|128;var h=[];'
  + 'for(var i=0;i<16;i++){var s=b[i].toString(16);h[i]=s.length===1?"0"+s:s}'
  + 'return h[0]+h[1]+h[2]+h[3]+"-"+h[4]+h[5]+"-"+h[6]+h[7]+"-"+h[8]+h[9]+"-"+h[10]+h[11]+h[12]+h[13]+h[14]+h[15]}'
  + 'try{Object.defineProperty(c,"randomUUID",{value:u,configurable:true})}'
  + 'catch(e){try{c.randomUUID=u}catch(e2){}}}'
  + 'var AS=globalThis.AbortSignal;'
  + 'if(AS&&typeof AS.any!=="function"){AS.any=function(ss){var x=new AbortController();'
  + 'function a(){x.abort()};for(var i=0;i<ss.length;i++){if(ss[i].aborted){x.abort();return x.signal}'
  + 'ss[i].addEventListener("abort",a,{once:true})}return x.signal}}'
  + 'var CONN=' + JSON.stringify(CONNECTION_CLIENT_ID) + ';'
  + 'function wrapApply(fn){'
  + 'if(fn&&fn.__dshFullRemoteApply)return fn;'
  + 'function wrapped(ctx){'
  + 'var result=fn.apply(this,arguments);'
  + 'function pin(){'
  + 'if(!ctx||typeof ctx.get!=="function"||globalThis.__DSH_FULL_REMOTE_TRUSTED__!==1)return;'
  + 'try{var connection=ctx.get("connection",false);'
  + 'if(connection&&typeof connection==="object"){'
  + 'Object.defineProperty(connection,"isLoopback",{value:true,configurable:true,enumerable:true,writable:true})}'
  + '}catch(e5){try{console.warn("[dsh-full-remote] could not pin connection.isLoopback",e5)}catch(e5b){}}'
  + '}'
  + 'if(result&&typeof result.then==="function")return result.then(function(v){pin();return v});'
  + 'pin();'
  + 'return result'
  + '}'
  + 'try{Object.defineProperty(wrapped,"__dshFullRemoteApply",{value:true})}catch(eW){wrapped.__dshFullRemoteApply=true}'
  + 'return wrapped}'
  + 'function wrapExports(mod){if(!mod)return mod;'
  + 'try{if(typeof mod.apply==="function")mod.apply=wrapApply(mod.apply);'
  + 'if(mod.default&&typeof mod.default.apply==="function")mod.default.apply=wrapApply(mod.default.apply)}catch(e8){'
  + 'try{console.warn("[dsh-full-remote] ModuleLoader export wrap failed",e8);'
  + 'globalThis.__DSH_FULL_REMOTE_BOOTSTRAP_FAILED__=1}catch(e8b){}}'
  + 'return mod}'
  + 'function wrapLoadFn(fn){'
  + 'if(typeof fn!=="function")return fn;'
  + 'if(fn.__dshFullRemoteLoad)return fn;'
  + 'function wrappedLoad(h){'
  + 'if(h&&h.id===CONN&&typeof h.factory==="function"){'
  + 'var inner=h.factory;'
  + 'h=Object.assign({},h,{factory:function(req){return wrapExports(inner(req))}})'
  + '}'
  + 'return fn.call(this,h)};'
  + 'try{Object.defineProperty(wrappedLoad,"__dshFullRemoteLoad",{value:true})}catch(eL){wrappedLoad.__dshFullRemoteLoad=true}'
  + 'return wrappedLoad}'
  + 'function installLoadTrap(loader){'
  + 'if(!loader)return;'
  + 'var desc;try{desc=Object.getOwnPropertyDescriptor(loader,"load")}catch(eD){desc=undefined}'
  + 'if(desc&&typeof desc.set==="function"&&desc.set.__dshFullRemoteLoadTrap)return;'
  + 'var current=wrapLoadFn(typeof loader.load==="function"?loader.load:undefined);'
  + 'function setLoad(v){current=wrapLoadFn(v)}'
  + 'setLoad.__dshFullRemoteLoadTrap=true;'
  + 'try{Object.defineProperty(loader,"load",{configurable:true,enumerable:true,get:function(){return current},set:setLoad})}'
  + 'catch(eT){if(typeof loader.load==="function")loader.load=wrapLoadFn(loader.load)}}'
  + 'function wrapCreate(loader){'
  + 'if(!loader||typeof loader.create!=="function"||loader.create.__dshFullRemoteCreate)return;'
  + 'var origCreate=loader.create;'
  + 'function wrappedCreate(){'
  + 'var result=origCreate.apply(this,arguments);'
  + 'installLoadTrap(this);'
  + 'installLoadTrap(loader);'
  + 'if(result&&result!==loader&&result!==this)installLoadTrap(result);'
  + 'return result}'
  + 'try{Object.defineProperty(wrappedCreate,"__dshFullRemoteCreate",{value:true})}catch(eC){wrappedCreate.__dshFullRemoteCreate=true}'
  + 'try{loader.create=wrappedCreate}catch(eC2){'
  + 'try{console.warn("[dsh-full-remote] ModuleLoader create wrap failed",eC2)}catch(eC3){}}}'
  + 'function wrapLoader(loader){'
  + 'if(!loader)return loader;'
  + 'installLoadTrap(loader);'
  + 'wrapCreate(loader);'
  + 'try{Object.defineProperty(loader,"__dshFullRemoteTrusted",{value:true})}catch(e9){loader.__dshFullRemoteTrusted=true}'
  + 'return loader}'
  + 'var current;'
  + 'try{current=globalThis.__ModuleLoader__;'
  + 'Object.defineProperty(globalThis,"__ModuleLoader__",{'
  + 'configurable:true,enumerable:true,'
  + 'get:function(){return current},'
  + 'set:function(v){current=wrapLoader(v)}'
  + '});'
  + 'if(current)current=wrapLoader(current);'
  + 'try{Object.defineProperty(globalThis,"__DSH_FULL_REMOTE_TRUSTED__",{value:1,configurable:true})}'
  + 'catch(e3){try{globalThis.__DSH_FULL_REMOTE_TRUSTED__=1}catch(e4){}}'
  + '}catch(e10){'
  + 'try{console.warn("[dsh-full-remote] __ModuleLoader__ wrap failed — settings may stay memory-scoped",e10);'
  + 'globalThis.__DSH_FULL_REMOTE_BOOTSTRAP_FAILED__=1}catch(e10b){}}'
  + '})();'
