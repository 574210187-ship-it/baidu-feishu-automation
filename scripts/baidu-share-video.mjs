import CDP from 'chrome-remote-interface';
import { spawnSync } from 'node:child_process';
import { CDP_PORT } from './runtime-config.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const readClipboard = async (Runtime) => {
  if (Runtime) {
    try {
      const result = await Runtime.evaluate({
        expression: `(async () => {
          try {
            if (navigator.clipboard && navigator.clipboard.readText) return await navigator.clipboard.readText();
          } catch (e) {}
          return '';
        })()`,
        awaitPromise: true,
        returnByValue: true,
        timeout: 3000
      });
      const text = result?.result?.value;
      if (text) return String(text).trim();
    } catch { /* 页面剪贴板不可用时走下面的后备 */ }
  }
  if (process.platform === 'win32') {
    const result = spawnSync('powershell', ['-NoProfile', '-Command', 'Get-Clipboard -Raw'], { encoding: 'utf8' });
    if (result.status === 0) return String(result.stdout || '').trim();
    return '';
  }
  for (const cmd of [
    ['xclip', ['-selection', 'clipboard', '-o']],
    ['xsel', ['--clipboard', '--output']]
  ]) {
    const result = spawnSync(cmd[0], cmd[1], { encoding: 'utf8', timeout: 2000 });
    if (result.status === 0 && result.stdout) return String(result.stdout).trim();
  }
  return '';
};

export const createVideoShareLink = async ({ client, fileName }) => {
  const { Runtime, Input } = client;

  const evalPage = async (expression, timeout = 15000) => {
    const result = await Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true, timeout });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'Runtime.evaluate failed');
    return result.result.value;
  };

  await evalPage(`(() => {
    const close = document.querySelector('button.u-dialog__headerbtn, [aria-label="Close"], .u-dialog__close, .vp-dialog__close');
    if (close) close.click();
    return true;
  })()`).catch(() => false);
  await sleep(500);

  let sharePoint = null;
  for (let i = 0; i < 20; i += 1) {
    sharePoint = await evalPage(`(() => {
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
      };
      const buttons = [...document.querySelectorAll('button, [role=button], div, span')]
        .filter(visible)
        .filter((el) => {
          const text = (el.innerText || el.textContent || '').trim();
          return text === '分享' || el.getAttribute('title') === '分享';
        })
        .map((el) => el.closest('button, [role=button]') || el)
        .filter(visible);
      const btn = buttons
        .map((el) => {
          const r = el.getBoundingClientRect();
          return { el, r, text: (el.innerText || el.textContent || '').trim(), title: el.getAttribute('title') || '' };
        })
        .filter((x) => x.r.width > 0 && x.r.height > 0)
        .sort((a, b) => {
          const aButton = a.el.tagName === 'BUTTON' ? 0 : 1;
          const bButton = b.el.tagName === 'BUTTON' ? 0 : 1;
          return aButton - bButton || b.r.width * b.r.height - a.r.width * a.r.height;
        })[0];
      if (!btn) return null;
      btn.el.click();
      return { x: Math.round(btn.r.x + btn.r.width / 2), y: Math.round(btn.r.y + btn.r.height / 2), text: btn.text, title: btn.title };
    })()`);
    if (sharePoint) break;
    await sleep(500);
  }
  if (!sharePoint) return { ok: false, reason: 'video share button not found' };

  for (let i = 0; i < 30; i += 1) {
    await sleep(500);
    const ready = await evalPage(`(() => {
      const body = document.body.innerText;
      return !!document.querySelector('.u-dialog__wrapper, [role="dialog"]') &&
        body.includes(${JSON.stringify(fileName)}) &&
        (body.includes('永久有效') || body.includes('创建链接') || body.includes('复制链接'));
    })()`);
    if (ready) break;
    if (i === 29) return { ok: false, reason: 'share dialog not visible' };
  }

  let permanent = { ok: false, reason: 'no permanent option' };
  for (let i = 0; i < 30; i += 1) {
    permanent = await evalPage(`(() => {
      const exact = (el) => (el.innerText || el.textContent || '').trim() === '永久有效';
      const node = [...document.querySelectorAll('.u-dialog__wrapper label, [role="dialog"] label, label, .u-radio-button__inner')]
        .find(exact);
      const target = node?.closest?.('label') || node;
      if (!target) return { ok: false, reason: 'no permanent option' };
      target.click();
      return { ok: true, cls: (target.className || '').toString() };
    })()`);
    if (permanent.ok) break;
    await sleep(500);
  }
  if (!permanent.ok) return permanent;
  await sleep(800);

  let action = { ok: false, reason: 'no create/copy button' };
  for (let i = 0; i < 30; i += 1) {
    action = await evalPage(`(() => {
      const btn = [...document.querySelectorAll('.u-dialog__wrapper button, [role="dialog"] button, button')]
        .find((el) => {
          const text = (el.innerText || el.textContent || '').trim();
          return text.includes('创建链接') || text.includes('复制链接');
        });
      if (!btn) return { ok: false, reason: 'no create/copy button' };
      const text = (btn.innerText || btn.textContent || '').trim();
      btn.click();
      return { ok: true, text };
    })()`);
    if (action.ok) break;
    await sleep(500);
  }
  if (!action.ok) return action;

  let copyResult = { ok: false, reason: 'no copy link button' };
  for (let i = 0; i < 20; i += 1) {
    copyResult = await evalPage(`(() => {
      const btn = [...document.querySelectorAll('.u-dialog__wrapper button, [role="dialog"] button, button')]
        .find((el) => {
          const text = (el.innerText || el.textContent || '').trim();
          return text.includes('复制链接');
        });
      if (!btn) return { ok: false, reason: 'no copy link button' };
      btn.click();
      return { ok: true, text: (btn.innerText || btn.textContent || '').trim() };
    })()`);
    if (copyResult.ok) break;
    await sleep(500);
  }

  let parsed = null;
  for (let i = 0; i < 30; i += 1) {
    await sleep(500);
    const fromInputs = await evalPage(`(() => {
      const box = document.querySelector('.vp-dialog') || document;
      const link = box.querySelector('.vp-link-info__link-info-url')?.value || '';
      const code = box.querySelector('.vp-link-info__link-pwd-val')?.value || '';
      return { link, code };
    })()`);
    if (fromInputs.link) {
      parsed = { ...fromInputs, source: 'input' };
      break;
    }
    const clipboard = await readClipboard(Runtime);
    const bodyTail = await evalPage(`(() => document.body.innerText.slice(-2000))()`);
    const text = `${clipboard}\n${bodyTail}`;
    const link = text.match(/https?:\/\/[^\s]+/i)?.[0] || '';
    const code = text.match(/(?:提取码|密码|访问码)[:：\s]*([A-Za-z0-9]{4})/)?.[1] || '';
    if (link) {
      parsed = { link, code, source: clipboard ? 'clipboard' : 'page' };
      break;
    }
  }

  await evalPage(`(() => {
    const close = document.querySelector('button.u-dialog__headerbtn, [aria-label="Close"], .u-dialog__close, .vp-dialog__close');
    if (close) close.click();
    return true;
  })()`).catch(() => false);
  await sleep(500);

  if (!parsed) return { ok: false, reason: 'share link not found after create/copy' };
  return { ok: true, link: parsed.link, code: parsed.code, action: action.text, sharePoint };
};

export const connectVideoPage = async ({ port = CDP_PORT } = {}) => {
  let target = (await CDP.List({ port })).find((t) => t.type === 'page' && t.url.includes('/pfile/video'));
  if (!target) target = await CDP.New({ port, url: 'about:blank' });
  const client = await CDP({ port, target });
  await client.Page.enable();
  await client.Runtime.enable();
  const { windowId } = await client.Browser.getWindowForTarget({ targetId: target.id });
  await client.Browser.setWindowBounds({ windowId, bounds: { left: 0, top: 0, width: 1500, height: 950, windowState: 'normal' } });
  await sleep(1000);
  return { client, target };
};
