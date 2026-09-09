#!/usr/bin/env node
const { launch } = require('../src/main/native/launcher');
function main(args = process.argv.slice(2)) { return launch(args); }
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main };
