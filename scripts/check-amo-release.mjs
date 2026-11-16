import { readFileSync } from 'node:fs';
import { createHmac, randomUUID } from 'node:crypto';

const credentials = {};
for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
  const match = line.match(/^\s*(WEB_EXT_API_KEY|WEB_EXT_API_SECRET)\s*=\s*(.*?)\s*$/);
  if (match) credentials[match[1]] = match[2].replace(/^(["'])(.*)\1$/, '$2');
}
if (!credentials.WEB_EXT_API_KEY || !credentials.WEB_EXT_API_SECRET) {
  throw new Error('AMO credentials are missing');
}
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const now = Math.floor(Date.now() / 1000);
const unsigned = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({
  iss: credentials.WEB_EXT_API_KEY, jti: randomUUID(), iat: now, exp: now + 60,
})}`;
const signature = createHmac('sha256', credentials.WEB_EXT_API_SECRET).update(unsigned).digest('base64url');
const headers = { Authorization: `JWT ${unsigned}.${signature}` };
const base = 'https://addons.mozilla.org/api/v5/addons/addon/workspaces%40hardfox';
for (const [label, endpoint] of [
  ['addon', `${base}/?cachebust=${Date.now()}`],
  ['versions', `${base}/versions/?filter=all_with_unlisted&page_size=50`],
]) {
  const response = await fetch(endpoint, { headers });
  if (!response.ok) throw new Error(`AMO ${label} request failed: HTTP ${response.status}`);
  const data = await response.json();
  if (label === 'addon') console.log(JSON.stringify({ label, id: data.id, slug: data.slug,
    currentVersion: data.current_version?.version, versionId: data.current_version?.id,
    channel: data.current_version?.channel, status: data.current_version?.file?.status,
    fileUrl: data.current_version?.file?.url, url: data.url }));
  else console.log(JSON.stringify({ label, count: data.count, next: data.next,
    versions: data.results.slice(0, 5).map(v => ({ id: v.id, version: v.version, channel: v.channel,
      status: v.file?.status, fileUrl: v.file?.url, hash: v.file?.hash })) }));
}
