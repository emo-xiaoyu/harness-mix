const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

async function main() {
  const port = process.argv[2] || '57989';
  const targets = await getJson(`http://127.0.0.1:${port}/json/list`);
  const page = targets.find(t => t.type === 'page' && t.url === 'app://-/index.html');
  if (!page) throw new Error('main page not found');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let id = 0;
  const pending = new Map();
  ws.onmessage = ev => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  };
  const send = (method, params) => new Promise(res => {
    const i = ++id;
    pending.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params }));
  });

  const evaluate = async expr => {
    const result = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (result.result?.exceptionDetails) {
      throw new Error(JSON.stringify(result.result.exceptionDetails));
    }
    return result.result?.result?.value;
  };

  console.log('Waiting for probe to mount...');
  await evaluate(`(async () => {
    for (let i = 0; i < 50; i++) {
      if (window.__harnessmixRendererBindingProbeV1 && document.querySelector('.ProseMirror')) break;
      await new Promise(r => setTimeout(r, 100));
    }
  })()`);

  const directClientTest = await evaluate(`(async () => {
    try {
      const probe = window.__harnessmixRendererBindingProbeV1;
      return {
        hasProbe: !!probe,
        probeKeys: probe ? Object.keys(probe) : []
      };
    } catch (e) {
      return { error: e.message, stack: e.stack };
    }
  })()`);
  console.log('Direct client test:', JSON.stringify(directClientTest, null, 2));

  console.log('Focusing editor and positioning caret at end...');
  await evaluate(`(() => {
    const editor = document.querySelector('.ProseMirror');
    if (!editor) return;
    editor.focus();
    const p = editor.querySelector('p') || editor;
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(p);
    range.collapse(false);
    sel?.removeAllRanges();
    sel?.addRange(range);
  })()`);

  // Send input via CDP
  console.log('Sending CDP input for #...');
  await send('Input.insertText', { text: '#' });
  await new Promise(r => setTimeout(r, 600));

  const menuInfo = await evaluate(`(() => {
    const menu = document.querySelector('[data-harness-mix-mentions]');
    const tabs = [...document.querySelectorAll('[data-harness-mix-mentions] [role="tab"]')].map(t => t.textContent.trim());
    const options = [...document.querySelectorAll('[data-harness-mix-mentions] [role="option"]')].map(opt => {
      const name = opt.querySelector('span[style*="font-weight:600"]')?.textContent || opt.innerText;
      const desc = opt.querySelector('span[style*="font-size:11px"]')?.textContent || '';
      return { name, desc, disabled: opt.hasAttribute('disabled') };
    });
    return {
      lastMentionDebug: window.__lastMentionDebug,
      menuHidden: menu ? menu.hidden : true,
      menuDisplay: menu ? menu.style.display : null,
      menuRect: menu ? { left: menu.style.left, top: menu.style.top, bottom: menu.style.bottom } : null,
      tabs,
      optionCount: options.length,
      sampleOptions: options.slice(0, 8)
    };
  })()`);
  console.log('Menu state after typing #:', JSON.stringify(menuInfo, null, 2));

  // Capture screenshot with popup open
  const shot1 = await send('Page.captureScreenshot', { format: 'png' });
  const data1 = shot1.result?.data || shot1.data;
  if (data1) {
    await fs.mkdir('output', { recursive: true });
    await fs.writeFile(path.resolve('output/live-hash-mentions.png'), Buffer.from(data1, 'base64'));
    console.log('Saved output/live-hash-mentions.png');
  }

  // 2. Select an agent (e.g. click first option) and verify badge styling
  const state2 = await evaluate(`(async () => {
    const firstOption = document.querySelector('[data-harness-mix-mentions] [role="option"]:not([disabled])');
    if (firstOption) {
      firstOption.click();
      await new Promise(r => setTimeout(r, 200));
    }
    const badges = [...document.querySelectorAll('[data-harness-mix-selected-mentions] [data-harness-mix-mention-badge]')].map(b => ({
      text: b.textContent.trim(),
      title: b.title,
      color: b.style.color
    }));
    const containerHasAttr = document.querySelector('[data-harness-mix-has-mentions="true"]') !== null;
    return { badges, containerHasAttr };
  })()`);
  console.log('State after selecting agent:', JSON.stringify(state2, null, 2));

  // Capture screenshot with badge in input box
  const shot2 = await send('Page.captureScreenshot', { format: 'png' });
  const data2 = shot2.result?.data || shot2.data;
  if (data2) {
    await fs.writeFile(path.resolve('output/live-hash-selected-badge.png'), Buffer.from(data2, 'base64'));
    console.log('Saved output/live-hash-selected-badge.png');
  }

  // 3. Clear badge so we leave the UI clean
  await evaluate(`(() => {
    const badge = document.querySelector('[data-harness-mix-selected-mentions] [data-harness-mix-mention-badge]');
    if (badge) badge.click();
    const editor = document.querySelector('[contenteditable="true"], .ProseMirror, textarea');
    if (editor && !editor.value) editor.textContent = '';
  })()`);

  ws.close();
  console.log('Done!');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
