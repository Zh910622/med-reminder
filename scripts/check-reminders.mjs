// 用药提醒检查脚本（GitHub Actions 每 5 分钟运行一次）
// 读取加密的 data.enc → 解密 → 检查北京时间下"到点 15 分钟仍未打卡"的剂量 → WxPusher 推送微信
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import crypto from 'node:crypto';

const ENC_FILE = 'data.enc';
const GRACE_MIN = 15; // 到点后宽限分钟数，仍未打卡才提醒

function deriveKey(pass, salt) {
  return crypto.pbkdf2Sync(pass, salt, 150000, 32, 'sha256');
}
function decrypt(text, pass) {
  const raw = Buffer.from(text.trim().replace(/^ENC1:/, ''), 'base64');
  const salt = raw.subarray(0, 16);
  const iv = raw.subarray(16, 28);
  const ct = raw.subarray(28);
  const tag = ct.subarray(ct.length - 16);
  const data = ct.subarray(0, ct.length - 16);
  const d = crypto.createDecipheriv('aes-256-gcm', deriveKey(pass, salt), iv);
  d.setAuthTag(tag);
  return JSON.parse(Buffer.concat([d.update(data), d.final()]).toString('utf8'));
}
function encrypt(obj, pass) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', deriveKey(pass, salt), iv);
  const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final(), c.getAuthTag()]);
  return 'ENC1:' + Buffer.concat([salt, iv, ct]).toString('base64');
}
function pad(n) { return n < 10 ? '0' + n : '' + n; }
// 当前北京时间（用 UTC+8 计算，无夏令时）
function nowCN() { return new Date(Date.now() + 8 * 3600 * 1000); }

async function main() {
  const pass = process.env.DATA_PASSPHRASE;
  const token = process.env.WXPUSHER_TOKEN;
  const uid = process.env.WXPUSHER_UID;
  if (!pass || !token || !uid) { console.log('缺少 Secrets（DATA_PASSPHRASE / WXPUSHER_TOKEN / WXPUSHER_UID），跳过'); return; }
  console.log('数据密码指纹:', crypto.createHash('sha256').update(pass).digest('hex').slice(0, 8), '（应与页面同步设置里显示的「密码指纹」一致）');
  if (!existsSync(ENC_FILE)) { console.log('data.enc 不存在：还没在页面上保存过数据，跳过'); return; }

  const data = decrypt(readFileSync(ENC_FILE, 'utf8'), pass);
  const now = nowCN();
  const today = now.getUTCFullYear() + '-' + pad(now.getUTCMonth() + 1) + '-' + pad(now.getUTCDate());
  const nowMin = now.getUTCHours() * 60 + now.getUTCMinutes();

  // 只保留最近 14 天的提醒标记，防止文件膨胀
  if (data.reminded) {
    const keys = Object.keys(data.reminded).sort();
    while (keys.length > 14) delete data.reminded[keys.shift()];
  }

  const takenMap = (data.records && data.records[today]) || {};
  const remindedMap = (data.reminded && data.reminded[today]) || {};
  const due = [];
  for (const med of data.meds || []) {
    const cnt = takenMap[med.id] || 0;
    (med.slots || []).forEach((t, i) => {
      if (cnt >= i + 1) return;                       // 已打卡
      const m = /^(\d{1,2}):(\d{2})$/.exec(t || '');
      if (!m) return;
      if (nowMin < (+m[1]) * 60 + (+m[2]) + GRACE_MIN) return; // 还没到宽限点
      if (remindedMap[med.id + '-' + i]) return;      // 今天已提醒过
      due.push({ med, i, t });
    });
  }
  if (!due.length) { console.log('北京时间 ' + today + ' ' + pad(now.getUTCHours()) + ':' + pad(now.getUTCMinutes()) + '，无需提醒'); return; }

  data.reminded = data.reminded || {};
  data.reminded[today] = data.reminded[today] || {};
  let changed = false;
  for (const d of due) {
    const content = '用药提醒：' + d.med.name + ' 今天第 ' + (d.i + 1) + ' 次（' + d.t + '）还没打卡。\n吃完后记得打开打卡页面点一下哦。';
    try {
      const res = await fetch('https://wxpusher.zjiecode.com/api/send/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          appToken: token,
          content,
          summary: '提醒：' + d.med.name + ' 第' + (d.i + 1) + '次未服',
          contentType: 1,
          uids: [uid],
        }),
      });
      const j = await res.json();
      console.log('推送 ' + d.med.name + ' 第' + (d.i + 1) + '次：code=' + j.code + ' msg=' + (j.msg || ''));
      if (j.code === 1000) { data.reminded[today][d.med.id + '-' + d.i] = true; changed = true; }
    } catch (e) {
      console.log('推送失败（下一轮重试）：' + e.message);
    }
  }
  if (changed) {
    await uploadFlags(data, pass);
  }
}

// 把"已提醒"标记用 GitHub API 上传（拉最新→合并→上传，带重试，避免与页面同步的 git 冲突）
async function uploadFlags(data, pass) {
  writeFileSync(ENC_FILE, encrypt(data, pass)); // 本地留存，便于排查
  const repo = process.env.GITHUB_REPOSITORY;
  const tk = process.env.GITHUB_TOKEN;
  if (!repo || !tk) { console.log('缺少 GITHUB_TOKEN，提醒标记未上传（下次可能重复提醒一次）'); return; }
  for (let attempt = 1; attempt <= 3; attempt++) {
    let sha = null, remote = null;
    const gr = await fetch(`https://api.github.com/repos/${repo}/contents/data.enc?ref=main`, {
      headers: { Authorization: 'Bearer ' + tk, Accept: 'application/vnd.github+json' },
    });
    if (gr.ok) {
      const j = await gr.json();
      sha = j.sha;
      const raw = Buffer.from(String(j.content).replace(/\n/g, ''), 'base64').toString('utf8');
      try { remote = decrypt(raw, pass); } catch { remote = null; }
    } else if (gr.status !== 404) {
      console.log('读取远端 data.enc 失败 (' + gr.status + ')，标记未上传');
      return;
    }
    if (remote) {
      // 合并页面在检查期间产生的打卡数据（按 天/药 取最大次数），reminded 取并集
      data.records = data.records || {};
      remote.records = remote.records || {};
      for (const d of Object.keys(remote.records)) {
        const m = Object.assign({}, data.records[d] || {});
        for (const k of Object.keys(remote.records[d])) m[k] = Math.max(m[k] || 0, remote.records[d][k]);
        data.records[d] = m;
      }
      data.reminded = Object.assign({}, remote.reminded || {}, data.reminded || {});
    }
    const put = await fetch(`https://api.github.com/repos/${repo}/contents/data.enc`, {
      method: 'PUT',
      headers: { Authorization: 'Bearer ' + tk, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'chore: 更新提醒标记',
        content: Buffer.from(encrypt(data, pass)).toString('base64'),
        branch: 'main',
        ...(sha ? { sha } : {}),
      }),
    });
    if (put.ok) { console.log('提醒标记已上传（API 方式，无冲突）'); return; }
    console.log('标记上传失败 (' + put.status + ')，重试 ' + attempt + '/3');
  }
  console.log('标记上传三次均失败——下次运行可能重复推送一次，不影响提醒功能');
}

main().catch((e) => { console.error(e); process.exit(1); });
