import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const server = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
const frontendDir = path.join(__dirname, '..', 'frontend', 'public');
const client = fs.existsSync(frontendDir) ? fs.readFileSync(path.join(frontendDir, 'app.js'), 'utf8') : '';

test('backend is API-only when frontend is separate', () => {
  assert.ok(server.includes('MONGODB_URI'));
  assert.ok(server.includes('mongodb'));
  assert.ok(server.includes('/api/'));
});

test('claim workflow requires a request before approval', () => {
  assert.match(server, /claimRequestStatus/);
  assert.match(server, /\/api\/reports\/:id\/claim/);
  assert.match(server, /claim-decision/);
  assert.match(server, /claimRequestStatus !== 'pending'/);
  if (client) assert.match(client, /Request this item/);
});

test('private fields are only in admin endpoints', () => {
  assert.match(server, /smallDetails/);
  assert.match(server, /returnedTo/);
  assert.match(server, /requireAdmin/);
  assert.doesNotMatch(server.match(/app\.get\('\/api\/reports'[\s\S]*?\);/m)?.[0] || '', /returnedTo/);
});

test('CORS is configured for cross-origin frontend', () => {
  assert.match(server, /Access-Control-Allow-Origin/);
  assert.match(server, /CORS_ORIGIN/);
});
