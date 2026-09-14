// Native sessions own connections, tool discovery, authentication and approvals.
function nativeServers(managed = [], collaboration) {
  return [...managed, ...(collaboration ? [{ name: 'harness-mix', ...collaboration }] : [])];
}
function acpServers(managed, collaboration) {
  return nativeServers(managed, collaboration).map(s => {
    if (s.url) {
      return {
        name: s.name,
        url: s.url,
        headers: Object.entries(s.http_headers || {}).map(([name, value]) => ({ name, value })),
      };
    }
    return {
      name: s.name,
      command: s.command,
      args: s.args || [],
      env: Object.entries(s.env || {}).map(([name, value]) => ({ name, value })),
    };
  });
}
function namedServers(managed, collaboration) {
  return Object.fromEntries(nativeServers(managed, collaboration).map(({ name, ...server }) => [name, server]));
}
module.exports = { nativeServers, acpServers, namedServers };
