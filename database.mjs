import { randomUUID } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

export function openDatabase(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  return db;
}

function verify(db) {
  if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok' ||
      db.prepare('PRAGMA foreign_key_check').get()) throw new Error('La base contiene errores de integridad.');
  db.prepare('SELECT id FROM users LIMIT 1').get();
}

export async function snapshot(source,destination,restore=false) {
  mkdirSync(dirname(destination),{recursive:true});
  if (existsSync(destination)) throw new Error('El archivo de destino ya existe.');
  const temp = join(dirname(destination),`.${randomUUID()}.sqlite`);
  const reader = new DatabaseSync(source,{readOnly:true});
  try {
    await backup(reader,temp);
    const copy = openDatabase(temp);
    try {
      verify(copy);
      if (restore) {
        copy.exec('DELETE FROM sessions');
        const queue = copy.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='email_queue'").get();
        if (queue) copy.exec("UPDATE email_queue SET status='skipped' WHERE status IN ('pending','sending')");
      }
      copy.exec('PRAGMA journal_mode=DELETE');
    } finally { copy.close(); }
    linkSync(temp,destination);
  } finally {
    reader.close();
    for (const suffix of ['','-wal','-shm','-journal']) rmSync(temp+suffix,{force:true});
  }
}

async function main() {
  const [action,arg,...rest] = process.argv.slice(2);
  if (!arg || rest.length || !['backup','restore'].includes(action)) {
    throw new Error('Uso: node database.mjs backup <archivo> | node database.mjs restore <respaldo>');
  }
  const database = resolve(process.env.DATA_DIR || 'data','cosecha.sqlite');
  if (action === 'restore' && ['','-wal','-shm','-journal'].some(suffix => existsSync(database+suffix))) {
    throw new Error('Configura DATA_DIR con un directorio de recuperación sin una base existente.');
  }
  const destination = action === 'backup' ? resolve(arg) : database;
  await snapshot(action === 'backup' ? database : resolve(arg),destination,action === 'restore');
  console.log(destination);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
