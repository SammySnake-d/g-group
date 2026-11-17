// 复用已完成的真实模型任务,只验最终打包版启动/持久化/大截图和真实文件发送。
import assert from 'node:assert/strict';
import {cpSync,existsSync,mkdirSync,readFileSync,readdirSync,appendFileSync,rmSync,writeFileSync,statSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { _electron as electron,expect } from '@playwright/test';
const [source,out,bin]=process.argv.slice(2);
assert([source,out,bin].every(p=>p&&path.isAbsolute(p)));
assert(!existsSync(out),'输出目录不能覆盖');
mkdirSync(out);
const ud=path.join(out,'userdata');
cpSync(path.join(source,'userdata'),ud,{recursive:true,filter:p=>!p.endsWith('/gg-config.json')&&!path.basename(p).startsWith('Singleton')});
const log=s=>{const line=`${new Date().toISOString()} ${s}`;console.log(line);appendFileSync(path.join(out,'steps.log'),line+'\n');};
const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>k!=='ELECTRON_RUN_AS_NODE'&&!k.startsWith('GG_')&&!k.startsWith('ANTHROPIC_')));
const cc=JSON.parse(readFileSync(path.join(os.homedir(),'.claude/settings.json'),'utf8')).env;
const app=await electron.launch({executablePath:bin,env:{...env,GG_USER_DATA_DIR:ud,GG_UPDATE_AUTO:'off'}});
const errors=[];
try {
 const win=await app.firstWindow();win.on('pageerror',e=>errors.push(e.message));
 log(`最终安装包启动:${bin};版本=${await app.evaluate(({app})=>app.getVersion())}`);
 await win.getByTestId('setup-screen').waitFor();
 await win.getByTestId('setup-base-url').fill(cc.ANTHROPIC_BASE_URL);
 await win.getByTestId('setup-token').fill(cc.ANTHROPIC_AUTH_TOKEN);
 await win.getByTestId('setup-model').fill('workbuddy-ai/deepseek-v4.1-flash-sg');
 await win.getByTestId('setup-save').click();
 await expect(win.getByTestId('backend-demo')).toHaveAttribute('data-wire','live',{timeout:30000});
 await expect(win.getByTestId('backend-demo')).toHaveAttribute('data-failed','0');
 log('真实模型后端已连接;沿用已完成任务,不重复派活');
 for(const [kind,name,file,text] of [['dm','小克','hello.txt','你好，g-group'],['g','闭环验收群','group.txt','群聊闭环通过']]) {
  await win.getByTestId('nav-chat').click();
  await win.getByTestId('list').locator(`[data-testid^="conv-${kind}-"]`).filter({hasText:name}).click();
  const line=win.getByTestId('chat-column').locator('[data-testid^="compute-line-"]').first();
  await expect(line).toHaveAttribute('data-state','done',{timeout:30000});
  const id=(await line.getAttribute('data-testid')).slice('compute-line-'.length);
  assert.equal(readFileSync(path.join(ud,'gg-data','compute',id,file),'utf8').replace(/\r?\n$/,''),text);
  await expect(win.locator('[data-testid^="trail-"]').filter({has:win.getByTestId(`compute-line-${id}`)})).toHaveCount(1);
  await win.screenshot({path:path.join(out,`${kind}-已完成任务与交付.png`)});
  log(`持久化通过:${kind};任务=${id};${file} 内容精确匹配;交付消息关联存在`);
  if(kind==='dm') {
   await line.click();await win.getByTestId('cview-activity').click();
   await win.screenshot({path:path.join(out,'dm-Compute过程.png')});await win.keyboard.press('Escape');
  }
 }
 await expect(win.getByTestId('chat-title')).toContainText('(4)');
 await win.getByTestId('chat-title').click();
 await expect(win.getByTestId('side-members-drop')).toContainText('小美');
 await win.screenshot({path:path.join(out,'group-成员持久化.png')});
 await win.keyboard.press('Escape');
 // 同一群聊画面在上版触发 256 KiB IPC 拒绝;直接点入口,不缩小图片绕过边界。
 const store=path.join(ud,'gg-data','attachments');
 const before=new Set(existsSync(store)?readdirSync(store):[]);
 await win.getByTestId('tool-shot').click();
 const shot=win.getByTestId('chat-column').getByTestId(/^attachment-截图 .*\.png$/).last();
 await expect(shot).toBeVisible({timeout:30000});
 await expect(shot.locator('xpath=ancestor::*[@data-msg][1]')).toHaveAttribute('data-msg',/#\d+$/);
 const pngs=readdirSync(store).filter(f=>!before.has(f)&&readFileSync(path.join(store,f)).subarray(0,8).toString('hex')==='89504e470d0a1a0a');
 assert.equal(pngs.length,1);
 const bytes=statSync(path.join(store,pngs[0])).size;
 assert(bytes*4/3>256*1024,'应实际覆盖超过旧 IPC 限额的大截图');
 log(`当前窗口截图发送通过:PNG=${bytes}字节;已取得后端消息序号,超过旧256KiB限额`);
 await win.screenshot({path:path.join(out,'group-大截图已发送.png')});
 const local=path.join(out,'本地路径 文件.txt');writeFileSync(local,'本地路径发送通过\n');
 await win.getByTestId('file-input').setInputFiles(local);
 await expect(win.getByTestId('attachment-本地路径 文件.txt')).toBeVisible({timeout:30000});
 await win.screenshot({path:path.join(out,'group-本地文件已发送.png')});
 log('本地文件发送通过:含空格与中文文件名,真实磁盘 File');
 assert.deepEqual(errors,[]);log('最终打包版续验通过:旧模型闭环结果完整保留;截图与文件发送通过;页面错误0');
} catch(e) {
 log(`续验失败:${e.message}`);
 const w=app.windows()[0];if(w)await w.screenshot({path:path.join(out,'失败现场.png')}).catch(()=>{});
 throw e;
} finally {await app.close();rmSync(path.join(ud,'gg-config.json'),{force:true});}
