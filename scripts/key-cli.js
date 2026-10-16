#!/usr/bin/env node
// Offline admin CLI for API keys.
//
// This is the documented, safe bootstrap path for the first key: there is
// deliberately NO unauthenticated HTTP admin endpoint. It talks to the storage
// backend directly (same DATA_DIR / STORAGE_BACKEND as the server).
//
//   node scripts/key-cli.js create --tenant alice [--container demo_user] [--name "laptop"] [--expires 2027-01-01T00:00:00Z] [--json]
//   node scripts/key-cli.js list   --tenant alice [--json]
//   node scripts/key-cli.js revoke --tenant alice --id key_xxx [--json]
//   node scripts/key-cli.js revoke --tenant alice --key sm_xxx [--json]
//
// The raw key is printed exactly once (at create time) and is never stored.

const db = require("../lib/db");
const { issueApiKey, hashApiKey } = require("../lib/auth");

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      if (eq !== -1) {
        args[token.slice(2, eq)] = token.slice(eq + 1);
      } else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) {
        args[token.slice(2)] = argv[i + 1];
        i += 1;
      } else {
        args[token.slice(2)] = true;
      }
    } else {
      args._.push(token);
    }
  }
  return args;
}

function fail(message) {
  console.error(`error: ${message}`);
  process.exitCode = 1;
}

function cmdCreate(args) {
  if (!args.tenant) return fail("--tenant is required");
  const { key, record } = issueApiKey(db, {
    tenantId: args.tenant,
    containerTag: args.container || null,
    name: args.name || null,
    expiresAt: args.expires || null,
  });

  if (args.json) {
    // The raw key is included exactly once, here, and only on this command.
    console.log(
      JSON.stringify(
        {
          key,
          id: record.id,
          tenantId: record.tenantId,
          defaultContainer: record.defaultContainer,
          name: record.name,
          createdAt: record.createdAt,
          expiresAt: record.expiresAt,
        },
        null,
        2
      )
    );
    return;
  }

  console.log("API key created. This secret is shown ONCE — store it now.");
  console.log("");
  console.log(`  ${key}`);
  console.log("");
  console.log(`  key id:    ${record.id}`);
  console.log(`  tenant:    ${record.tenantId}`);
  console.log(`  container: ${record.defaultContainer}`);
  if (record.expiresAt) console.log(`  expires:   ${record.expiresAt}`);
}

function cmdList(args) {
  if (!args.tenant) return fail("--tenant is required");
  const keys = db.listApiKeys(args.tenant);
  if (args.json) {
    console.log(JSON.stringify(keys, null, 2));
    return;
  }
  if (!keys.length) {
    console.log(`no keys for tenant "${args.tenant}"`);
    return;
  }
  for (const k of keys) {
    const state = k.revokedAt ? "revoked" : "active";
    console.log(
      `${k.id}  ${state.padEnd(7)}  container=${k.defaultContainer}  ` +
        `created=${k.createdAt}  lastUsed=${k.lastUsedAt || "-"}  name=${k.name || "-"}`
    );
  }
}

function cmdRevoke(args) {
  if (!args.tenant) return fail("--tenant is required");
  let id = args.id;
  if (!id && args.key) {
    const record = db.getApiKeyByHash(hashApiKey(args.key));
    if (!record) return fail("no key matches the supplied --key");
    if (record.tenantId !== args.tenant) {
      return fail("the supplied key does not belong to this tenant");
    }
    id = record.id;
  }
  if (!id) return fail("--id (or --key) is required");

  const changed = db.revokeApiKey(id, args.tenant, new Date().toISOString());
  if (!changed) return fail(`no active key "${id}" for tenant "${args.tenant}"`);
  if (args.json) console.log(JSON.stringify({ ok: true, id, tenantId: args.tenant }));
  else console.log(`revoked ${id}`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  try {
    if (command === "create") cmdCreate(args);
    else if (command === "list") cmdList(args);
    else if (command === "revoke") cmdRevoke(args);
    else {
      console.error("usage: key-cli.js <create|list|revoke> [options]");
      process.exitCode = 1;
    }
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
}

main();
