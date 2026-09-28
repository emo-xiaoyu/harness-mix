const assert = require('node:assert/strict');
const { createPiSubagentBridge } = require('../src/main/adapters/pi-subagents');

(async () => {
  const events = [];
  let bridge;
  const process = { async command(command) {
    assert.equal(command.type, 'prompt');
    const requestId = command.message.split(' ')[1];
    assert.match(command.message, /^\/subagents-inspect-rpc /);
    bridge.onEvent({ type: 'extension_ui_request', method: 'setWidget', widgetKey: 'subagent-inspect',
      widgetLines: [`PI_SUBAGENT_INSPECT_JSON:${JSON.stringify({ kind: 'pi-subagents.inspect-reply', version: 1,
        requestId, asyncId: 'run-1', childId: 'step:0', status: 'complete', label: 'reviewer', task: '检查实现',
        messages: [{ role: 'user', kind: 'text', text: '检查实现' }, { role: 'assistant', kind: 'text', text: '通过' }] })}`] });
    return {};
  } };
  bridge = createPiSubagentBridge(process, 'pi-parent', event => events.push(event));
  const snapshot = { kind: 'pi-subagents.async-status-snapshot', version: 1, runs: [
    { id: 'run-1', kind: 'workflow', label: 'review', state: 'running', children: [
      { id: 'step:0', kind: 'step', label: 'reviewer', state: 'running' },
    ] },
  ] };
  assert.equal(bridge.onEvent({ type: 'extension_ui_request', method: 'setWidget', widgetKey: 'subagent-async',
    widgetLines: [`PI_SUBAGENT_ASYNC_JSON:${JSON.stringify(snapshot)}`] }), true);
  assert.equal(events[0].nativeSessionId, 'pi-parent:pi-subagents:run-1:step:0');
  await new Promise(resolve => setTimeout(resolve, 500));
  const transcript = events.filter(event => event.kind === 'native-subagent').at(-1);
  assert.equal(transcript.status, 'success');
  assert.equal(transcript.messages[1].parts[0].text, '通过');
  bridge.onEvent({ type: 'tool_execution_update', toolName: 'subagent', toolCallId: 'call-2', partialResult: { details: {
    mode: 'workflow', results: [{ index: 0, agent: 'worker', task: '[prompt redacted]' }],
  } } });
  const pending = events.filter(event => event.nativeSessionId === 'pi-parent:pi-subagents:tool:call-2:step:0').at(-1);
  assert.equal(pending.status, 'running');
  assert.equal(pending.task, '');
  bridge.onEvent({ type: 'tool_execution_end', toolName: 'subagent', toolCallId: 'call-2', result: { details: {
    mode: 'workflow', runId: 'run-2', results: [{ index: 0, agent: 'worker', task: '修复', exitCode: 0,
      messages: [{ role: 'assistant', content: [{ type: 'text', text: '已修复' }] }] }],
  } } });
  const foreground = events.filter(event => event.nativeSessionId === pending.nativeSessionId).at(-1);
  assert.equal(foreground.status, 'success');
  assert.equal(foreground.messages[1].parts[0].text, '已修复');
  bridge.close();
  console.log('Pi subagent RPC widget and inspection projection passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
