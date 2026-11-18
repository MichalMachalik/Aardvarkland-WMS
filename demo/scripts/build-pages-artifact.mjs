import { cp, lstat, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const site = join(root, '_site');
const runtimeEntries = [
  '.nojekyll',
  'index.html',
  'database-schema.html',
  'database-schema.css',
  'database-schema.js',
  'mobile-preview.html',
  'app.js',
  'cycle-counts.js',
  'styles.css',
  'demo-login.css',
  'demo-login.js',
  'order-walkthrough.css',
  'order-walkthrough.js',
  'source-parity.css',
  'source-parity.js',
  'assets',
];

const forbiddenSegments = new Set([
  '.git', '.github', 'node_modules', 'e2e', 'scripts', 'docs',
  'artifacts', 'test-results', 'coverage', 'reports',
]);
const forbiddenExtensions = new Set([
  '.map', '.md', '.ts', '.tsx', '.yml', '.yaml', '.ps1', '.bat', '.cmd',
  '.sh', '.zip', '.tar', '.gz', '.apk', '.aab', '.db', '.sqlite', '.sqlite3',
  '.log', '.pem', '.key', '.p12', '.pfx', '.jks', '.keystore',
]);
const textExtensions = new Set([
  '.html', '.css', '.js', '.mjs', '.json', '.webmanifest', '.svg', '.txt', '.xml',
]);
const forbiddenContent = [
  ['non-public repository marker', /-Private\b/i],
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i],
  ['GitHub token', /\b(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,})\b/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['service API key', /\b(?:sk|rk)-[A-Za-z0-9_-]{20,}\b/],
  ['credentialed database URL', /\bpostgres(?:ql)?:\/\/[^\s"'`:/]+:[^\s"'`@]+@/i],
];

const maxFiles = 500;
const maxTotalBytes = 50 * 1024 * 1024;

await rm(site, { recursive: true, force: true });
await mkdir(site, { recursive: true });

for (const entry of runtimeEntries) {
  const source = resolve(root, entry);
  assertInside(root, source, entry);
  const info = await lstat(source);
  if (info.isSymbolicLink()) throw new Error(`Runtime entry must not be a symbolic link: ${entry}`);
  await cp(source, join(site, entry), { recursive: true, force: true });
}

const schemaSource = await readFile(join(root, '..', 'backend', 'prisma', 'schema.prisma'), 'utf8');
const schemaModels = [...schemaSource.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)].map(([, name, body]) => {
  const fields = [];
  const relations = [];
  const table = body.match(/@@map\("([^"]+)"\)/)?.[1] ?? name;
  for (const line of body.split(/\r?\n/)) {
    const field = line.match(/^\s*(\w+)\s+([\w]+(?:\?|\[\])?)(.*)$/);
    if (!field) continue;
    const [, fieldName, fieldType, attributes] = field;
    fields.push({ name: fieldName, type: fieldType.replace(/\?$/, '').replace(/\[\]$/, '[]'), optional: fieldType.includes('?'), key: attributes.includes('@id') ? 'PK' : attributes.includes('@unique') ? 'UQ' : '' });
    const relationTarget = fieldType.replace(/[?\[\]]/g, '');
    const foreignKeys = attributes.match(/@relation\([^)]*fields:\s*\[([^\]]+)\]/)?.[1]
      ?.split(',').map((part) => part.trim()).filter(Boolean) ?? [];
    if (foreignKeys.length) relations.push({ target: relationTarget, field: fieldName, keys: foreignKeys });
  }
  for (const [, key, names] of body.matchAll(/@@(id|unique)\(\[([^\]]+)\]\)/g)) {
    for (const fieldName of names.split(',').map((part) => part.trim())) {
      const field = fields.find((item) => item.name === fieldName);
      if (field && !field.key) field.key = key === 'id' ? 'PK' : 'UQ';
    }
  }
  return { name, table, fields, relations };
});
const knownModels = new Set(schemaModels.map((model) => model.name));
const referenceAliases = {
  client: 'WmsClient', ownerClient: 'WmsClient', order: 'OutboundOrder', package: 'ShipmentPackage',
  user: 'User', actorUser: 'User', assignedUser: 'User', shipment: 'Shipment',
};
for (const model of schemaModels) {
  model.links = model.relations.map((relation) => ({ target: relation.target, field: relation.keys.join(', '), declared: true }));
  for (const field of model.fields.filter((item) => item.name.endsWith('Id'))) {
    const base = field.name.slice(0, -2);
    const target = referenceAliases[base] ?? `${base[0]?.toUpperCase() ?? ''}${base.slice(1)}`;
    if (!knownModels.has(target) || target === model.name || model.links.some((link) => link.target === target)) continue;
    model.links.push({ target, field: field.name, declared: false });
  }
}
const classifyModel = (name) => {
  if (/^(Billing|ClientRate|InvoiceNumber|StorageOccupancy)/.test(name)) return 'Billing';
  if (/^(User|Role|Permission|WmsClient|ClientWarehouse|ClientSkuAlias|ClientResourceLink|UserClientAccess|EnterpriseCustomerPortal)/.test(name)) return 'People and clients';
  if (/^(Warehouse|DockDoor|YardTrailer|DockAppointment)/.test(name)) return 'Warehouse layout';
  if (/^(Inbound|Parcel|Return|Quality)/.test(name)) return 'Receiving and quality';
  if (/^(Outbound|Shipment|Package|Carrier|Pick|Packing|WarehouseTask|WarehouseOrder|HandlingUnit)/.test(name)) return 'Fulfillment';
  if (/^(Product|Sku|Stock|Reservation|CycleCount|Replenishment|Slotting|SerialNumber|CrossDock|KitBom|Vas)/.test(name)) return 'Products and inventory';
  if (/^(Scanner|Label|Notification|Tracking|WmsException|AuditLog|Automation|EnterpriseRf|EnterprisePrint|EnterpriseWarehouse|EnterpriseLabor)/.test(name)) return 'Warehouse operations';
  if (/^(Integration|External|Webhook|DomainEvent|Idempotency|Outbox|Inbox|Enterprise)/.test(name)) return 'Integrations and events';
  if (/^(Auth|Mfa|RefreshToken|RateLimit)/.test(name)) return 'Security and access';
  return 'Supporting records';
};
const schemaMap = {
  source: 'backend/prisma/schema.prisma',
  models: schemaModels.map((model) => ({
    ...model,
    group: classifyModel(model.name),
    relations: model.relations.filter((relation) => knownModels.has(relation.target)),
    links: model.links.filter((link) => knownModels.has(link.target)),
  })),
};
await writeFile(join(site, 'database-schema.json'), `${JSON.stringify(schemaMap)}\n`);

const topLevel = (await readdir(site)).sort();
const expectedTopLevel = [...runtimeEntries, 'database-schema.json'].sort();
if (JSON.stringify(topLevel) !== JSON.stringify(expectedTopLevel)) {
  throw new Error(`Unexpected Pages top-level entries: ${topLevel.join(', ')}`);
}

let fileCount = 0;
let totalBytes = 0;
for await (const file of walk(site)) {
  const relativePath = relative(site, file).split(sep).join('/');
  const segments = relativePath.split('/');
  if (segments.some((segment) => forbiddenSegments.has(segment))) {
    throw new Error(`Forbidden Pages path: ${relativePath}`);
  }

  const extension = extname(relativePath).toLowerCase();
  if (forbiddenExtensions.has(extension)) {
    throw new Error(`Forbidden Pages file type: ${relativePath}`);
  }

  const info = await lstat(file);
  if (info.isSymbolicLink()) throw new Error(`Symbolic links are not allowed in Pages: ${relativePath}`);
  fileCount += 1;
  totalBytes += info.size;
  if (fileCount > maxFiles) throw new Error(`Pages artifact exceeds ${maxFiles} files.`);
  if (totalBytes > maxTotalBytes) throw new Error(`Pages artifact exceeds ${maxTotalBytes} bytes.`);

  if (textExtensions.has(extension)) {
    const text = await readFile(file, 'utf8');
    for (const [label, pattern] of forbiddenContent) {
      if (pattern.test(text)) throw new Error(`${label} found in Pages artifact: ${relativePath}`);
    }
  }
}

if (!fileCount) throw new Error('Pages artifact is empty.');
console.log(`Verified Pages artifact: ${fileCount} files, ${totalBytes} bytes.`);

async function* walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Symbolic links are not allowed in Pages: ${relative(site, path)}`);
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.isFile()) yield path;
    else throw new Error(`Unsupported Pages entry: ${relative(site, path)}`);
  }
}

function assertInside(base, candidate, label) {
  const rel = relative(base, candidate);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`)) {
    throw new Error(`Runtime entry escapes repository root: ${label}`);
  }
}
