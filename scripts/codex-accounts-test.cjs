const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CodexAccountManager } = require('../src/main/native/codex-accounts');

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-mix-codex-accounts-'));
  const servers = new Map();
  const emitted = [];
  const acquireServer = async (_diagnostic, codexHome) => {
    let server = servers.get(codexHome);
    if (!server) {
      const listeners = new Set();
      server = {
        refs: 0,
        account: null,
        requests: [],
        async request(method, params) {
          this.requests.push({ method, params });
          if (method === 'account/read') return { account: this.account };
          if (method === 'account/rateLimits/read') return { rateLimits: { primary: { usedPercent: 24, windowDurationMins: 300, resetsAt: 1_800_000_000 }, secondary: { usedPercent: 41, windowDurationMins: 10080, resetsAt: 1_800_604_800 } } };
          if (method === 'account/login/start') return { type: 'chatgptDeviceCode', loginId: 'login-isolated', verificationUrl: 'https://auth.example/device', userCode: 'WXYZ-1234' };
          if (method === 'account/login/cancel') return { status: 'cancelled' };
          throw new Error(`Unexpected fake Account request: ${method}`);
        },
        onNotification(listener) { listeners.add(listener); return () => listeners.delete(listener); },
        notify(message) { for (const listener of listeners) listener(message); },
        release() { this.refs--; },
      };
      servers.set(codexHome, server);
    }
    server.refs++;
    return server;
  };
  const official = async (method) => {
    if (method === 'account/read') return { account: { type: 'chatgpt', email: 'owner@example.com', planType: 'plus' } };
    throw new Error(`Unexpected official request: ${method}`);
  };
  const manager = new CodexAccountManager({ dataDirectory: root, requestOfficial: official, emit: message => emitted.push(message), acquireServer });
  try {
    const initial = await manager.list();
    assert.equal(initial.accounts.length, 1);
    assert.equal(initial.accounts[0].email, 'owner@example.com');
    assert.equal(initial.accounts[0].management, 'native');

    const created = await manager.create('工作账号');
    assert.equal(created.account.management, 'isolated');
    assert.equal(created.account.authenticated, false);
    const context = manager.executionContext(created.account.accountId);
    assert.ok(context.codexHome.startsWith(path.join(root, 'codex-accounts', 'profiles') + path.sep));
    const server = servers.get(context.codexHome);
    server.account = { type: 'chatgpt', email: 'work@example.com', planType: 'pro' };

    const activated = await manager.activate(created.account.accountId);
    assert.equal(activated.account.active, true);
    const accounts = await manager.list(true);
    assert.equal(accounts.accounts.find(account => account.isDefault).active, false);
    assert.equal(accounts.accounts.find(account => account.accountId === created.account.accountId).email, 'work@example.com');
    const usage = await manager.usage(created.account.accountId);
    assert.equal(usage.usage.planFiveHourUsedPercent, 24);
    assert.equal(usage.accountCredits.productUsage[0].usagePercent, 41);

    const login = await manager.startLogin(created.account.accountId);
    assert.equal(login.userCode, 'WXYZ-1234');
    server.notify({ method: 'account/login/completed', params: { loginId: login.loginId, success: true, error: null } });
    assert.deepEqual(emitted.at(-1), { method: 'codexhost/account/login/completed', params: { accountId: created.account.accountId, loginId: login.loginId, success: true, error: null } });

    const registry = fs.readFileSync(path.join(root, 'codex-accounts', 'accounts.json'), 'utf8');
    assert.equal(registry.includes('owner@example.com'), false, 'Registry must not persist native identity or credentials');
    assert.equal(registry.includes('work@example.com'), false, 'Registry must not persist isolated identity or credentials');
    await manager.delete(created.account.accountId);
    assert.equal(fs.existsSync(context.codexHome), false);
  } finally {
    manager.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log('Codex multi-account isolation, switching, usage and login lifecycle passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
