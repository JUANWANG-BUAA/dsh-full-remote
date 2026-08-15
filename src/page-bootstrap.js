/**
 * Head IIFE injected by tapIndex. Runs before the web shell installs
 * `window.__ModuleLoader__`, so it can wrap connection.provide and force
 * `isLoopback` on a page this plugin already authenticated.
 *
 * Official settings / models / locale bind during their own apply, which
 * is earlier than any third-party client plugin. Wrapping `settingsScope.bind`
 * later cannot rewrite scopes that already chose `persistence: 'memory'`.
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
  + 'try{Object.defineProperty(globalThis,"__DSH_FULL_REMOTE_TRUSTED__",{value:1,configurable:true})}'
  + 'catch(e3){try{globalThis.__DSH_FULL_REMOTE_TRUSTED__=1}catch(e4){}}'
  + 'var CONN=' + JSON.stringify(CONNECTION_CLIENT_ID) + ';'
  + 'function wrapApply(fn){return function(ctx){'
  + 'if(!ctx||typeof ctx.provide!=="function")return fn.apply(this,arguments);'
  + 'var orig=ctx.provide;'
  + 'ctx.provide=function(key,value){'
  + 'if(key==="connection"&&value&&typeof value==="object"&&globalThis.__DSH_FULL_REMOTE_TRUSTED__===1){'
  + 'try{Object.defineProperty(value,"isLoopback",{value:true,configurable:true,enumerable:true,writable:true})}catch(e5){}'
  + '}'
  + 'return orig.apply(this,arguments)};'
  + 'try{return fn.apply(this,arguments)}'
  + 'finally{try{delete ctx.provide}catch(e6){try{ctx.provide=orig}catch(e7){}}}'
  + '}}'
  + 'function wrapExports(mod){if(!mod)return mod;'
  + 'try{if(typeof mod.apply==="function")mod.apply=wrapApply(mod.apply);'
  + 'if(mod.default&&typeof mod.default.apply==="function")mod.default.apply=wrapApply(mod.default.apply)}catch(e8){}'
  + 'return mod}'
  + 'function wrapLoader(loader){'
  + 'if(!loader||typeof loader.load!=="function"||loader.__dshFullRemoteTrusted)return loader;'
  + 'var origLoad=loader.load;'
  + 'loader.load=function(h){'
  + 'if(h&&h.id===CONN&&typeof h.factory==="function"){'
  + 'var inner=h.factory;'
  + 'h=Object.assign({},h,{factory:function(req){return wrapExports(inner(req))}})'
  + '}'
  + 'return origLoad.call(this,h)};'
  + 'try{Object.defineProperty(loader,"__dshFullRemoteTrusted",{value:true})}catch(e9){loader.__dshFullRemoteTrusted=true}'
  + 'return loader}'
  + 'var current;'
  + 'try{current=globalThis.__ModuleLoader__;'
  + 'Object.defineProperty(globalThis,"__ModuleLoader__",{'
  + 'configurable:true,enumerable:true,'
  + 'get:function(){return current},'
  + 'set:function(v){current=wrapLoader(v)}'
  + '});'
  + 'if(current)current=wrapLoader(current)}catch(e10){}'
  + '})();'
