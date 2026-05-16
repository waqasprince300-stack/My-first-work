const https = require('https');

const DEFAULT_DOH =
  process.env.MONGODB_DOH_URL?.trim() || 'https://cloudflare-dns.com/dns-query';

/**
 * When local DNS cannot resolve mongodb+srv (queryTxt ETIMEOUT / querySrv ECONNREFUSED),
 * resolve SRV + TXT via DNS-over-HTTPS and build a standard mongodb:// connection string.
 */
function dohRequest(name, type) {
  const url = `${DEFAULT_DOH}?name=${encodeURIComponent(name)}&type=${encodeURIComponent(type)}`;
  return new Promise((resolve, reject) => {
    https.get(
      url,
      { headers: { accept: 'application/dns-json' } },
      (res) => {
        let body = '';
        res.on('data', (c) => {
          body += c;
        });
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(e);
          }
        });
      },
    ).on('error', reject);
  });
}

function parseSrvAnswers(json) {
  const hosts = [];
  for (const a of json.Answer || []) {
    if (a.type !== 33) continue;
    const parts = String(a.data || '').trim().split(/\s+/);
    if (parts.length < 4) continue;
    const port = parts[2];
    const target = parts[3].replace(/\.$/, '');
    hosts.push(`${target}:${port}`);
  }
  return hosts.sort();
}

function parseTxtOptions(json) {
  const chunks = [];
  for (const a of json.Answer || []) {
    if (a.type !== 16) continue;
    let d = String(a.data || '');
    if (d.startsWith('"') && d.endsWith('"')) d = d.slice(1, -1);
    chunks.push(d);
  }
  return chunks.join('');
}

function parseMongoSrvUri(uri) {
  const prefix = 'mongodb+srv://';
  if (!uri.startsWith(prefix)) {
    throw new Error('Not a mongodb+srv URI');
  }
  let rest = uri.slice(prefix.length);
  let userInfo = '';
  const at = rest.indexOf('@');
  if (at !== -1) {
    userInfo = rest.slice(0, at + 1);
    rest = rest.slice(at + 1);
  }
  let host;
  let pathAndQuery = '';
  const slash = rest.indexOf('/');
  if (slash === -1) {
    host = rest.split('?')[0];
    const q = rest.indexOf('?');
    pathAndQuery = q === -1 ? '' : rest.slice(q);
  } else {
    host = rest.slice(0, slash).split('?')[0];
    pathAndQuery = rest.slice(slash);
  }
  if (!host) throw new Error('Missing host in mongodb+srv URI');
  return { userInfo, host, pathAndQuery };
}

function buildPathAndQuery(pathAndQuery, txtOpts) {
  let pathname = '/';
  let existingQuery = '';
  if (pathAndQuery) {
    const q = pathAndQuery.indexOf('?');
    if (q === -1) {
      pathname = pathAndQuery;
    } else {
      pathname = pathAndQuery.slice(0, q) || '/';
      existingQuery = pathAndQuery.slice(q + 1);
    }
  }
  const params = new URLSearchParams(existingQuery);
  const txtParams = new URLSearchParams(txtOpts.replace(/^["']|["']$/g, ''));
  txtParams.forEach((v, k) => {
    if (!params.has(k)) params.set(k, v);
  });
  if (!params.has('tls') && !params.has('ssl')) {
    params.set('tls', 'true');
  }
  const s = params.toString();
  if (pathname === '/' || pathname === '') {
    return s ? `/?${s}` : '/?tls=true';
  }
  return `${pathname}?${s}`;
}

async function resolveMongoSrvViaDoh(srvUri) {
  const { userInfo, host, pathAndQuery } = parseMongoSrvUri(srvUri);
  const srvName = `_mongodb._tcp.${host}`;

  const [srvJson, txtJson] = await Promise.all([
    dohRequest(srvName, 'SRV'),
    dohRequest(host, 'TXT'),
  ]);

  if (srvJson.Status !== 0) {
    throw new Error(`DoH SRV lookup failed (DNS status ${srvJson.Status})`);
  }
  if (txtJson.Status !== 0) {
    throw new Error(`DoH TXT lookup failed (DNS status ${txtJson.Status})`);
  }

  const hosts = parseSrvAnswers(srvJson);
  if (!hosts.length) {
    throw new Error('DoH returned no SRV records');
  }

  const txtOpts = parseTxtOptions(txtJson);
  const tail = buildPathAndQuery(pathAndQuery, txtOpts);

  return `mongodb://${userInfo}${hosts.join(',')}${tail}`;
}

module.exports = {
  resolveMongoSrvViaDoh,
};
