const fs = require('fs');
const path = '/Users/ithustle/dev/deskotp/toquemedia-studio-api/src/__tests__/proxy.test.ts';
let code = fs.readFileSync(path, 'utf8');
code = code.replace(
  "'mimo-v2.5-pro-1m',\n      'minimax-m2.7',",
  "'mimo-v2.5-pro-1m',\n      'mimo-v2.5-pro-ultraspeed',\n      'minimax-m2.7',"
);
fs.writeFileSync(path, code);
