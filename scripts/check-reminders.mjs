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
    writeFileSync(ENC_FILE, encrypt(data, pass));
    console.log('已写入提醒标记');
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
