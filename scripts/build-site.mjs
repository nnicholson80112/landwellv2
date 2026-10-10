// Wraps apps/site/site.body.html (the editable page) into a full HTML document
// at apps/site/index.html, which the API serves at "/".
import { readFileSync, writeFileSync } from 'node:fs';
const body = readFileSync(new URL('../apps/site/site.body.html', import.meta.url), 'utf8');
const head = body.match(/^[\s\S]*?<\/style>/)[0];
const rest = body.slice(head.length);
writeFileSync(new URL('../apps/site/index.html', import.meta.url),
  `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n${head}\n</head>\n<body>\n${rest}\n</body>\n</html>\n`);
console.log('Built apps/site/index.html');
