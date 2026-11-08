import * as domain from '../src/index.ts';
const m=domain.contact; const d=m.addContact(m.emptyDirectory(),{id:'c',name:'n',speakingModel:'x'}).dir; const c=d.contacts.get('c');
const grant={name:'weather',bounded:true}, asset={name:'tool',kind:'mcp'}, req={task:'t',rules:[],tools:[],credentialRefs:[]}, rec={taskId:'t',commitmentIds:[],basedOnSeq:0}, commitment={id:'k',sourceSeq:0,text:'t',boundTaskIds:[],schedule:null}, caller={kind:'user',id:'u'}, entry={kind:'global'};
const cases=[
 ['addContact目录',()=>m.addContact(null,{id:'x',name:'n',speakingModel:'x'})],['addContact入参',()=>m.addContact(d,null)],
 ['updateContact目录',()=>m.updateContact(null,'c',{})],['updateContact标识',()=>m.updateContact(d,null,{})],['updateContact入参',()=>m.updateContact(d,'c',null)],
 ['grantTool状态',()=>m.grantTool(null,grant)],['grantTool入参',()=>m.grantTool(c,null)],
 ['grantComputeAsset状态',()=>m.grantComputeAsset(null,asset)],['grantComputeAsset入参',()=>m.grantComputeAsset(c,null)],
 ['canCallDirectly状态',()=>m.canCallDirectly(null,'x')],['canCallDirectly名称',()=>m.canCallDirectly(c,null)],
 ['commit状态',()=>m.commit(null,commitment)],['commit入参',()=>m.commit(c,null)],
 ['settleTask状态',()=>m.settleTask(null,'t')],['settleTask标识',()=>m.settleTask(c,null)],
 ['confirmFinalReport状态',()=>m.confirmFinalReport(null,rec)],['confirmFinalReport回执',()=>m.confirmFinalReport(c,null)],
 ['revokeCommitment状态',()=>m.revokeCommitment(null,'k')],['revokeCommitment标识',()=>m.revokeCommitment(c,null)],
 ['briefFor状态',()=>m.briefFor(null,req)],['briefFor入参',()=>m.briefFor(c,null)],
 ['routeHelper入口',()=>domain.routeHelper(null,caller,'u')],['routeHelper调用方',()=>domain.routeHelper(entry,null,'u')],['routeHelper用户',()=>domain.routeHelper(entry,caller,null)]
];
let thrown=0;for(const [name,f] of cases){try{const v=f();console.log(JSON.stringify({probe:'null',name,threw:false,ok:typeof v==='boolean'?v:v.ok}));}catch(e){thrown++;console.log(JSON.stringify({probe:'null',name,threw:true,error:String(e)}));}}
let traps=0; const prox=()=>new Proxy({},new Proxy({},{get:()=>()=>{traps++;throw new Error('unexpected trap')}}));
const pcases=[['grantTool',()=>m.grantTool(c,prox())],['commit',()=>m.commit(c,prox())],['briefFor',()=>m.briefFor(c,prox())],['confirmFinalReport',()=>m.confirmFinalReport(c,prox())],['state',()=>m.grantTool(prox(),grant)],['helper入口',()=>domain.routeHelper(prox(),caller,'u')],['helper调用方',()=>domain.routeHelper(entry,prox(),'u')]];
for(const [name,f] of pcases){const before=traps;try{const v=f();console.log(JSON.stringify({probe:'proxy',name,ok:v.ok,threw:false,traps:traps-before}));}catch(e){thrown++;console.log(JSON.stringify({probe:'proxy',name,threw:true,traps:traps-before,error:String(e)}));}}
let gets=0;const getObj=()=>Object.defineProperty({},'x',{get(){gets++;throw new Error('unexpected getter')}});
for(const [name,f] of [['grantTool',()=>m.grantTool(c,getObj())],['confirmFinalReport',()=>m.confirmFinalReport(c,{...rec,extra:getObj()})],['routeHelper',()=>domain.routeHelper({...entry,extra:getObj()},caller,'u')]]){const before=gets;try{const v=f();console.log(JSON.stringify({probe:'getter',name,ok:v.ok,threw:false,gets:gets-before}));}catch(e){thrown++;console.log(JSON.stringify({probe:'getter',name,threw:true,gets:gets-before,error:String(e)}));}}
const seen=new Set(), unfrozen=[];function walk(x,p){if(x===null||!['object','function'].includes(typeof x)||seen.has(x))return;seen.add(x);if(!Object.isFrozen(x))unfrozen.push(p);for(const k of Reflect.ownKeys(x)){const d=Object.getOwnPropertyDescriptor(x,k);if(d&&Object.hasOwn(d,'value'))walk(d.value,p+'.'+String(k));}}
for(const [name,v] of [['STATES',domain.STATES],['EVENT_KINDS',domain.EVENT_KINDS],['TABLE',domain.TABLE],['FORBIDDEN_DIRECT_TOOLS',m.FORBIDDEN_DIRECT_TOOLS]])walk(v,name);
let mutationThrew=false;try{m.FORBIDDEN_DIRECT_TOOLS[0]='marker';}catch{mutationThrew=true;}
console.log(JSON.stringify({probe:'summary',nullCases:cases.length,thrown,proxyTraps:traps,getterCalls:gets,policyObjects:seen.size,unfrozen,mutationThrew,firstTool:m.FORBIDDEN_DIRECT_TOOLS[0]}));
if(thrown||traps||gets||unfrozen.length||!mutationThrew||m.FORBIDDEN_DIRECT_TOOLS[0]!=='bash') process.exitCode=1;
