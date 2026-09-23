const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { CodexAppServer } = require('../adapters/codex-app-server');

const OFFICIAL_ACCOUNT_ID = 'official-codex';
const ACCOUNT_ID = /^[A-Za-z0-9._~-]{1,256}$/;
const PLAN_TYPES = new Set(['free', 'go', 'plus', 'pro', 'prolite', 'team', 'self_serve_business_prolite', 'self_serve_business_usage_based', 'business', 'ent26', 'enterprise_cbp_automation', 'enterprise_cbp_usage_based', 'enterprise', 'edu', 'edu_plus', 'edu_pro', 'unknown']);

function isoFromUnixSeconds(value) {
  return Number.isSafeInteger(value) && value >= 0 ? new Date(value * 1000).toISOString() : undefined;
}

function rateLimitView(result) {
  const snapshot = result?.rateLimits;
  const primary = snapshot?.primary;
  const secondary = snapshot?.secondary;
  const usage = {};
  if (typeof primary?.usedPercent === 'number' && primary.usedPercent >= 0 && primary.usedPercent <= 100) {
    usage.planFiveHourUsedPercent = primary.usedPercent;
    if (Number.isSafeInteger(primary.resetsAt) && primary.resetsAt >= 0) usage.planFiveHourResetsAtUnix = primary.resetsAt;
  }
  if (typeof secondary?.usedPercent === 'number' && secondary.usedPercent >= 0 && secondary.usedPercent <= 100) {
    usage.planSevenDayUsedPercent = secondary.usedPercent;
    if (Number.isSafeInteger(secondary.resetsAt) && secondary.resetsAt >= 0) usage.planSevenDayResetsAtUnix = secondary.resetsAt;
  }
  let accountCredits;
  if (typeof primary?.usedPercent === 'number' && primary.usedPercent >= 0 && primary.usedPercent <= 100) {
    accountCredits = {
      usedPercent: primary.usedPercent,
      periodType: primary.windowDurationMins === 300 ? 'five_hour' : 'unknown',
      ...(isoFromUnixSeconds(primary.resetsAt) ? { resetsAt: isoFromUnixSeconds(primary.resetsAt) } : {}),
    };
    if (typeof secondary?.usedPercent === 'number' && secondary.usedPercent >= 0 && secondary.usedPercent <= 100) {
      accountCredits.productUsage = [{
        product: secondary.windowDurationMins === 10080 ? '7-day window' : (snapshot.limitName || 'Secondary limit'),
        usagePercent: secondary.usedPercent,
        ...(isoFromUnixSeconds(secondary.resetsAt) ? { resetsAt: isoFromUnixSeconds(secondary.resetsAt) } : {}),
      }];
    }
    const reset = result?.rateLimitResetCredits;
    if (Number.isSafeInteger(reset?.availableCount) && reset.availableCount > 0) {
      const expiresAt = Array.isArray(reset.credits)
        ? reset.credits.map(credit => isoFromUnixSeconds(credit?.expiresAt)).filter(Boolean).slice(0, 32)
        : [];
      accountCredits.resetCredits = {
        availableCount: reset.availableCount,
        ...(expiresAt.length ? { nextExpiresAt: expiresAt[0], expiresAt } : {}),
      };
    }
  }
  return { usage: Object.keys(usage).length ? usage : null, ...(accountCredits ? { accountCredits } : {}) };
}

function accountIdentity(account) {
  const email = account?.type === 'chatgpt' && typeof account.email === 'string' && account.email.trim()
    ? account.email.trim() : undefined;
  const planType = account?.type === 'chatgpt' && PLAN_TYPES.has(account.planType) ? account.planType : undefined;
  return { email, planType, authenticated: !!account };
}

class CodexAccountManager {
  constructor({ dataDirectory, requestOfficial, emit, acquireServer = CodexAppServer.acquire }) {
    this.root = path.resolve(dataDirectory, 'codex-accounts');
    this.profilesRoot = path.join(this.root, 'profiles');
    this.registryFile = path.join(this.root, 'accounts.json');
    this.requestOfficial = requestOfficial;
    this.emit = emit;
    this.acquireServer = acquireServer;
    this.logins = new Map();
    this.registry = this.#load();
  }

  #load() {
    try {
      const value = JSON.parse(fs.readFileSync(this.registryFile, 'utf8'));
      const seen = new Set();
      const accounts = (Array.isArray(value.accounts) ? value.accounts : []).filter(entry => {
        if (!entry || !ACCOUNT_ID.test(entry.accountId) || typeof entry.label !== 'string' || !entry.label.trim() || entry.accountId === OFFICIAL_ACCOUNT_ID || seen.has(entry.accountId)) return false;
        seen.add(entry.accountId);
        entry.label = entry.label.trim().slice(0, 256);
        // 旧结构条目才带 codexHome；非字符串的残留一律丢弃，回落到托管 profile 路径
        if (typeof entry.codexHome !== 'string' || !entry.codexHome.trim()) delete entry.codexHome;
        return true;
      }).slice(0, 127);
      const activeAccountId = value.activeAccountId === OFFICIAL_ACCOUNT_ID || accounts.some(entry => entry.accountId === value.activeAccountId)
        ? value.activeAccountId : OFFICIAL_ACCOUNT_ID;
      return { version: 1, activeAccountId, accounts };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return { version: 1, activeAccountId: OFFICIAL_ACCOUNT_ID, accounts: [] };
    }
  }

  #save() {
    fs.mkdirSync(this.root, { recursive: true });
    const temp = `${this.registryFile}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(this.registry, null, 2));
    fs.renameSync(temp, this.registryFile);
  }

  #entry(accountId) {
    if (accountId === OFFICIAL_ACCOUNT_ID) return { accountId, label: 'Codex 官方账号', codexHome: process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), native: true };
    const entry = this.registry.accounts.find(candidate => candidate.accountId === accountId);
    if (!entry) throw new Error('Unknown Codex account');
    // 旧结构条目带显式绝对 codexHome（如 default → ~/.codex）：尊重原路径。
    // codex 拒绝在不存在的 CODEX_HOME 下启动（进程退出码 1），改写路径会让这类账号
    // 的每次会话都死在拉起阶段，且用户无从看到原因。
    if (typeof entry.codexHome === 'string' && path.isAbsolute(entry.codexHome)) {
      const resolved = path.resolve(entry.codexHome);
      // 指向官方主目录的注册表条目（旧迁移遗留，如 default → ~/.codex）是同一份会话库的
      // 镜像：把它当隔离账号路由进 Host 会对同一存储建第二套管理视图，表现为权限菜单
      // 被 Harness Mix 接管、Desktop 原生执行路径再跑一遍、侧边栏出现两个相同会话。
      // 官方主目录一律视为 native 直通。
      const officialHome = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
      if (resolved.toLowerCase() === officialHome.toLowerCase()) {
        return { ...entry, codexHome: resolved, native: true };
      }
      return { ...entry, codexHome: resolved, native: false };
    }
    const codexHome = path.resolve(this.profilesRoot, entry.accountId);
    if (!codexHome.startsWith(`${path.resolve(this.profilesRoot)}${path.sep}`)) throw new Error('Invalid Codex account directory');
    // 托管 profile 目录缺失时自愈：目录被删/迁移未带上时补建空目录（未登录态），
    // 而不是让 codex app-server 直接拒绝启动
    if (!fs.existsSync(codexHome)) fs.mkdirSync(codexHome, { recursive: true });
    return { ...entry, codexHome, native: false };
  }

  async #request(entry, method, params) {
    if (entry.native) {
      if (!this.requestOfficial) throw new Error('Official Codex account service is unavailable');
      return this.requestOfficial(method, params);
    }
    const server = await this.acquireServer(undefined, entry.codexHome);
    try { return await server.request(method, params); }
    finally { server.release(); }
  }

  async #summary(entry, refreshToken = false) {
    let raw = null;
    try { raw = await this.#request(entry, 'account/read', { refreshToken }); }
    catch { /* A signed-out profile is still a useful selectable Account slot. */ }
    const identity = accountIdentity(raw?.account);
    return {
      accountId: entry.accountId,
      label: identity.email || entry.label,
      ...(identity.email ? { email: identity.email } : {}),
      ...(identity.planType ? { planType: identity.planType } : {}),
      codexHome: entry.codexHome,
      active: this.registry.activeAccountId === entry.accountId,
      isDefault: entry.native,
      authenticated: identity.authenticated,
      management: entry.native ? 'native' : 'isolated',
    };
  }

  async list(refresh = false) {
    const entries = [this.#entry(OFFICIAL_ACCOUNT_ID), ...this.registry.accounts.map(entry => this.#entry(entry.accountId))];
    return { accounts: await Promise.all(entries.map(entry => this.#summary(entry, refresh))) };
  }

  async create(label) {
    if (this.registry.accounts.length >= 127) throw new Error('Codex Account limit reached (128 including the official account)');
    const accountId = `account-${randomUUID().slice(0, 8)}`;
    const entry = { accountId, label: typeof label === 'string' && label.trim() ? label.trim().slice(0, 256) : `Codex 账号 ${this.registry.accounts.length + 2}`, createdAt: Date.now() };
    fs.mkdirSync(path.join(this.profilesRoot, accountId), { recursive: true });
    this.registry.accounts.push(entry);
    this.#save();
    return { account: await this.#summary(this.#entry(accountId)) };
  }

  async activate(accountId) {
    const entry = this.#entry(accountId);
    this.registry.activeAccountId = entry.accountId;
    this.#save();
    return { account: await this.#summary(entry) };
  }

  async delete(accountId) {
    const entry = this.#entry(accountId);
    if (entry.native) throw new Error('The official Codex account cannot be deleted');
    if ([...this.logins.values()].some(login => login.accountId === accountId)) throw new Error('Cancel account sign-in before deleting it');
    // 只删除托管 profile 目录（profiles/<accountId>）；旧条目指向的外部目录
    // （如 ~/.codex）绝不能随账号删除，但账号槽位本身要能移除
    const managed = path.join(path.resolve(this.profilesRoot), entry.accountId);
    if (path.resolve(entry.codexHome) === managed) fs.rmSync(managed, { recursive: true, force: true });
    this.registry.accounts = this.registry.accounts.filter(candidate => candidate.accountId !== accountId);
    if (this.registry.activeAccountId === accountId) this.registry.activeAccountId = OFFICIAL_ACCOUNT_ID;
    this.#save();
    return { deletedAccountId: accountId };
  }

  async startLogin(accountId) {
    const entry = this.#entry(accountId);
    if (entry.native) {
      const result = await this.#request(entry, 'account/login/start', { type: 'chatgptDeviceCode' });
      return { accountId, loginId: result.loginId, verificationUrl: result.verificationUrl, userCode: result.userCode };
    }
    const server = await this.acquireServer(undefined, entry.codexHome);
    let unwatch;
    try {
      unwatch = server.onNotification(message => {
        if (message?.method !== 'account/login/completed') return;
        const pending = this.logins.get(message.params?.loginId);
        if (!pending || pending.server !== server) return;
        this.logins.delete(message.params.loginId);
        pending.unwatch?.();
        pending.server.release();
        this.emit?.({ method: 'harnessmix/account/login/completed', params: {
          accountId: pending.accountId,
          loginId: message.params.loginId,
          success: message.params.success === true,
          error: typeof message.params.error === 'string' ? message.params.error : null,
        } });
      });
      const result = await server.request('account/login/start', { type: 'chatgptDeviceCode' });
      this.logins.set(result.loginId, { accountId, server, unwatch });
      return { accountId, loginId: result.loginId, verificationUrl: result.verificationUrl, userCode: result.userCode };
    } catch (error) {
      unwatch?.();
      server.release();
      throw error;
    }
  }

  async cancelLogin(loginId) {
    const pending = this.logins.get(loginId);
    if (!pending) {
      if (!this.requestOfficial) return { cancelled: false };
      const result = await this.requestOfficial('account/login/cancel', { loginId });
      return { cancelled: ['canceled', 'cancelled'].includes(result?.status) };
    }
    const result = await pending.server.request('account/login/cancel', { loginId });
    this.logins.delete(loginId);
    pending.unwatch?.();
    pending.server.release();
    return { cancelled: ['canceled', 'cancelled'].includes(result?.status) };
  }

  async usage(accountId) {
    const entry = this.#entry(accountId);
    return { accountId, ...rateLimitView(await this.#request(entry, 'account/rateLimits/read', {})) };
  }

  async consumeReset(accountId, idempotencyKey) {
    const entry = this.#entry(accountId);
    const result = await this.#request(entry, 'account/rateLimitResetCredit/consume', { idempotencyKey: idempotencyKey || randomUUID() });
    const refreshed = rateLimitView(await this.#request(entry, 'account/rateLimits/read', {}));
    return { accountId, outcome: result.outcome, ...(refreshed.accountCredits ? { accountCredits: refreshed.accountCredits } : {}) };
  }

  signedOutOfficial() {
    const entry = this.#entry(OFFICIAL_ACCOUNT_ID);
    return {
      account: {
        accountId: entry.accountId,
        label: entry.label,
        codexHome: entry.codexHome,
        active: this.registry.activeAccountId === entry.accountId,
        isDefault: true,
        authenticated: false,
        management: 'native',
      },
    };
  }

  executionContext(accountId) {
    const entry = this.#entry(accountId);
    if (entry.native) throw new Error('The official account stays on the native Codex route');
    return { accountId: entry.accountId, codexHome: entry.codexHome };
  }

  close() {
    for (const pending of this.logins.values()) { pending.unwatch?.(); pending.server.release(); }
    this.logins.clear();
  }
}

module.exports = { CodexAccountManager, OFFICIAL_ACCOUNT_ID, rateLimitView };
